/**
 * Generate multimodal embeddings using Qwen3-VL-Embedding via vLLM.
 * Directly embeds text AND images into the same vector space.
 *
 * Run: node generate-embeddings.js
 * Output: output/embeddings.json     (text embeddings)
 *         output/embeddings-img.json  (image embeddings)
 *
 * Requires: VLLM_URL in .env (default: http://localhost:8691)
 *
 * Model is read from output/settings.json → embeddingModel
 * Override with: EMBEDDING_MODEL env var
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

// ─── Model config ────────────────────────────────────────────────────────
const SETTINGS_PATH = './output/settings.json';
const MODELS = {
  'Qwen/Qwen3-VL-Embedding-2B':  { textBatch: 32, imgConcurrency: 16 },
  'Qwen/Qwen3-VL-Embedding-8B':  { textBatch: 16, imgConcurrency: 6 },
};
const DEFAULT_MODEL = 'Qwen/Qwen3-VL-Embedding-2B';

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

const settings = loadSettings();
const MODEL = process.env.EMBEDDING_MODEL || settings.embeddingModel || DEFAULT_MODEL;
const modelCfg = MODELS[MODEL] || MODELS[DEFAULT_MODEL];
const TEXT_BATCH = modelCfg.textBatch;
const IMG_CONCURRENCY = modelCfg.imgConcurrency;

const VLLM_URL = (process.env.VLLM_URL || 'http://localhost:8691').replace(/\/$/, '');

const POSTS_JSON = './output/saved_posts.json';
const TEXT_EMB_JSON = './output/embeddings.json';
const IMG_EMB_JSON = './output/embeddings-img.json';
const MEDIA_DIR = './output/media';

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

function sanitizeText(text) {
  return (text || '')
    .replace(/[^\x20-\x7E\xA0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, ' ')
    .trim();
}

function postKey(p) {
  return p.url || `index_${p.index}`;
}

// ─── Text embedding (batched) ───────────────────────────────────────────
async function embedTextBatch(texts) {
  const res = await fetch(`${VLLM_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// ─── Image embedding (one at a time via messages format) ────────────────
async function embedImage(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mime = mimeMap[ext] || 'image/jpeg';
  const b64 = readFileSync(filePath).toString('base64');

  const res = await fetch(`${VLLM_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function run() {
  console.log(`Model: ${MODEL}`);
  console.log(`Config: textBatch=${TEXT_BATCH}, imgConcurrency=${IMG_CONCURRENCY}`);

  // Test connectivity
  try {
    const h = await fetch(`${VLLM_URL}/health`);
    if (!h.ok) throw new Error(`${h.status}`);
    console.log(`vLLM server: ${VLLM_URL} ✓`);
  } catch (e) {
    console.error(`Cannot reach vLLM at ${VLLM_URL}: ${e.message}`);
    process.exit(1);
  }

  // Verify the model loaded on vLLM matches
  try {
    const mRes = await fetch(`${VLLM_URL}/v1/models`);
    const mData = await mRes.json();
    const served = mData.data?.[0]?.id;
    if (served && served !== MODEL) {
      console.error(`⚠ vLLM is serving "${served}" but settings say "${MODEL}"`);
      console.error(`  Update settings or restart vLLM with the correct model.`);
      process.exit(1);
    }
  } catch { /* ignore if /v1/models not available */ }

  const postsRaw = readFileSync(POSTS_JSON, 'utf8').replace(/[\uD800-\uDFFF]/g, '');
  const posts = JSON.parse(postsRaw);
  const textEmb = loadJSON(TEXT_EMB_JSON);
  const imgEmb = loadJSON(IMG_EMB_JSON);

  // ── Step 1: Text embeddings ───────────────────────────────────────────
  const toEmbedText = [];
  for (const p of posts) {
    const key = postKey(p);
    if (textEmb[key]) continue;
    const text = sanitizeText([p.author, p.text].filter(Boolean).join(' — '));
    if (!text) continue;
    toEmbedText.push({ key, text: text.slice(0, 2000) });
  }

  console.log(`\nText: ${Object.keys(textEmb).length} done, ${toEmbedText.length} to embed`);

  if (toEmbedText.length > 0) {
    let done = 0;
    for (let i = 0; i < toEmbedText.length; i += TEXT_BATCH) {
      const batch = toEmbedText.slice(i, i + TEXT_BATCH);
      try {
        const vectors = await embedTextBatch(batch.map(b => b.text));
        for (let j = 0; j < batch.length; j++) {
          textEmb[batch[j].key] = vectors[j];
        }
        done += batch.length;
        process.stdout.write(`\r  Text: ${done}/${toEmbedText.length}`);
      } catch (e) {
        console.error(`\nText batch ${i} failed: ${e.message}`);
        break;
      }
      if ((i / TEXT_BATCH) % 5 === 4) saveJSON(TEXT_EMB_JSON, textEmb);
    }
    saveJSON(TEXT_EMB_JSON, textEmb);
    console.log(`\n  Saved ${Object.keys(textEmb).length} text embeddings`);
  }

  // ── Step 2: Image embeddings ──────────────────────────────────────────
  const toEmbedImg = [];
  for (const p of posts) {
    const key = postKey(p);
    if (imgEmb[key]) continue;
    const imgs = (p.mediaFiles || []).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f.file));
    if (imgs.length === 0) continue;
    const filePath = join(MEDIA_DIR, imgs[0].file);
    if (!existsSync(filePath)) continue;
    toEmbedImg.push({ key, filePath });
  }

  console.log(`\nImages: ${Object.keys(imgEmb).length} done, ${toEmbedImg.length} to embed`);

  if (toEmbedImg.length > 0) {
    let done = 0, errors = 0;
    for (let i = 0; i < toEmbedImg.length; i += IMG_CONCURRENCY) {
      const chunk = toEmbedImg.slice(i, i + IMG_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async ({ key, filePath }) => {
          const vec = await embedImage(filePath);
          return { key, vec };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          imgEmb[r.value.key] = r.value.vec;
          done++;
        } else {
          errors++;
          if (errors <= 5) console.error(`\n  Error: ${r.reason?.message}`);
        }
      }
      process.stdout.write(`\r  Images: ${done}/${toEmbedImg.length} (${errors} errors)`);
      if (done % 20 < IMG_CONCURRENCY) saveJSON(IMG_EMB_JSON, imgEmb);
      if (errors > 50) { console.error('\nToo many errors, stopping.'); break; }
    }
    saveJSON(IMG_EMB_JSON, imgEmb);
    console.log(`\n  Saved ${Object.keys(imgEmb).length} image embeddings`);
  }

  console.log('\nDone!');
  console.log(`  Text embeddings:  ${Object.keys(textEmb).length}`);
  console.log(`  Image embeddings: ${Object.keys(imgEmb).length}`);
}

run().catch(e => { console.error(e); process.exit(1); });
