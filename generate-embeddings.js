/**
 * Incrementally generate text-only embeddings for LinkedIn posts with
 * tencent/R3-embedding-0.6b.
 */

import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import {
  EMBEDDING_MODEL,
  EMBEDDING_URL,
} from './search-runtime.js';

const POSTS_JSON = './output/saved_posts.json';
const EMBEDDINGS_JSON = './output/r3-text-embeddings.json';
const TEXT_BATCH = Number(process.env.R3_TEXT_BATCH || 32);
const MAX_TEXT_CHARS = Number(process.env.R3_MAX_TEXT_CHARS || 12_000);

function sanitizeText(text) {
  return (text || '')
    .replace(/[^\x20-\x7E\xA0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function postKey(post) {
  return post.url || `index_${post.index}`;
}

function postText(post) {
  return sanitizeText([post.author, post.text].filter(Boolean).join(' — ')).slice(0, MAX_TEXT_CHARS);
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex');
}

function loadIndex() {
  try {
    const value = JSON.parse(readFileSync(EMBEDDINGS_JSON, 'utf8'));
    if (value.model !== EMBEDDING_MODEL || !value.embeddings || !value.fingerprints) {
      return { model: EMBEDDING_MODEL, embeddings: {}, fingerprints: {} };
    }
    return value;
  } catch {
    return { model: EMBEDDING_MODEL, embeddings: {}, fingerprints: {} };
  }
}

function saveIndex(index) {
  writeFileSync(EMBEDDINGS_JSON, JSON.stringify({
    model: EMBEDDING_MODEL,
    dimensions: index.dimensions || null,
    updatedAt: new Date().toISOString(),
    embeddings: index.embeddings,
    fingerprints: index.fingerprints,
  }), 'utf8');
}

async function embedTextBatch(texts) {
  const response = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
}

async function run() {
  const health = await fetch(`${EMBEDDING_URL}/health`);
  if (!health.ok) throw new Error(`Embedding service is unhealthy: HTTP ${health.status}`);

  const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8').replace(/[\uD800-\uDFFF]/g, ''));
  const index = loadIndex();
  const pending = [];
  const activeKeys = new Set();

  for (const post of posts) {
    const key = postKey(post);
    const text = postText(post);
    if (!text) continue;
    activeKeys.add(key);
    const hash = fingerprint(text);
    if (index.embeddings[key] && index.fingerprints[key] === hash) continue;
    pending.push({ key, text, hash });
  }

  for (const key of Object.keys(index.embeddings)) {
    if (!activeKeys.has(key)) {
      delete index.embeddings[key];
      delete index.fingerprints[key];
    }
  }

  console.log(`[embeddings] Model: ${EMBEDDING_MODEL}`);
  console.log(`[embeddings] ${Object.keys(index.embeddings).length} current, ${pending.length} to generate`);

  let completed = 0;
  for (let offset = 0; offset < pending.length; offset += TEXT_BATCH) {
    const batch = pending.slice(offset, offset + TEXT_BATCH);
    const vectors = await embedTextBatch(batch.map(item => item.text));
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding API returned ${vectors.length} vectors for a batch of ${batch.length}`);
    }
    for (let i = 0; i < batch.length; i++) {
      index.embeddings[batch[i].key] = vectors[i];
      index.fingerprints[batch[i].key] = batch[i].hash;
      index.dimensions = vectors[i].length;
    }
    completed += batch.length;
    process.stdout.write(`\r[embeddings] Generated ${completed}/${pending.length}`);
    if (completed % (TEXT_BATCH * 5) === 0) saveIndex(index);
  }

  saveIndex(index);
  if (pending.length) process.stdout.write('\n');
  console.log(`[embeddings] Saved ${Object.keys(index.embeddings).length} text embeddings`);
}

run().catch(error => {
  console.error(`[embeddings] Fatal: ${error.message}`);
  process.exit(1);
});
