/**
 * API server for the LinkedIn Saved Posts viewer.
 * Run: node server.js (starts on port 4781)
 */

import 'dotenv/config';
import express from 'express';
import { execFileSync, execSync, spawn } from 'child_process';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  EMBEDDING_MODEL,
  EMBEDDING_URL,
  RERANK_MODEL,
  RERANK_URL,
  ensureSearchServices,
  getSearchServiceStatus,
  stopSearchServices,
} from './search-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const TASK_NAME = 'LinkedIn Saved Posts Daily Sync';
const SYNC_LOG = join(__dirname, 'output', 'sync-log.json');
const POSTS_JSON = join(__dirname, 'output', 'saved_posts.json');
const TEXT_EMB_JSON = join(__dirname, 'output', 'r3-text-embeddings.json');

// ─── Sync history and scheduler ─────────────────────────────────────────
app.get('/api/sync-log', (_req, res) => {
  try {
    res.json(JSON.parse(readFileSync(SYNC_LOG, 'utf8')));
  } catch {
    res.json([]);
  }
});

app.get('/api/scheduler', (_req, res) => {
  try {
    const output = execSync(`schtasks /query /tn "${TASK_NAME}" /fo LIST`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const nextRun = output.match(/Next Run Time:\s*(.+)/)?.[1]?.trim() ?? null;
    const lastRun = output.match(/Last Run Time:\s*(.+)/)?.[1]?.trim() ?? null;
    const status = output.match(/Status:\s*(.+)/)?.[1]?.trim() ?? null;
    const timeMatch = output.match(/(\d{1,2}):(\d{2}):00\s*(AM|PM)/i);
    let hour = 8;
    let minute = 0;
    if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
      minute = parseInt(timeMatch[2], 10);
      if (timeMatch[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (timeMatch[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
    }
    res.json({ enabled: true, nextRun, lastRun, status, hour, minute });
  } catch {
    res.json({ enabled: false, nextRun: null, lastRun: null, status: null, hour: 8, minute: 0 });
  }
});

app.post('/api/scheduler', (req, res) => {
  const { hour = 8, minute = 0 } = req.body;
  try {
    execSync('node setup-scheduler.js', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SYNC_HOUR: String(hour), SYNC_MINUTE: String(minute) },
    });
    res.json({ success: true });
  } catch (error) {
    const detail = (error.stderr || error.stdout || '').toString().trim();
    res.status(500).json({ error: detail || error.message });
  }
});

app.delete('/api/scheduler', (_req, res) => {
  try {
    execSync('node setup-scheduler.js --remove', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    res.json({ success: true });
  } catch (error) {
    const detail = (error.stderr || error.stdout || '').toString().trim();
    res.status(500).json({ error: detail || error.message });
  }
});

// ─── Manual sync ────────────────────────────────────────────────────────
let syncProc = null;
let syncLog = [];
let textEmbCache = null;
let textEmbCacheMtimeMs = 0;

app.post('/api/sync', (_req, res) => {
  if (syncProc) return res.status(409).json({ error: 'Sync already running' });

  syncLog = [];
  syncProc = spawn('node', ['sync-and-embed.js', '--visible'], {
    cwd: __dirname,
    env: { ...process.env },
  });
  const onData = data => syncLog.push(data.toString());
  syncProc.stdout.on('data', onData);
  syncProc.stderr.on('data', onData);
  syncProc.on('close', () => {
    textEmbCache = null;
    textEmbCacheMtimeMs = 0;
    syncProc = null;
  });
  res.json({ started: true });
});

app.get('/api/sync/status', (_req, res) => {
  res.json({ running: syncProc !== null, output: syncLog.join('') });
});

// ─── Post deletion ──────────────────────────────────────────────────────
app.delete('/api/posts/author', (req, res) => {
  try {
    const { author } = req.body;
    if (!author) return res.status(400).json({ error: 'author required' });
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const updated = posts.filter(post => post.author !== author);
    writeFileSync(POSTS_JSON, JSON.stringify(updated, null, 2));
    res.json({ deleted: posts.length - updated.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/posts/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const updated = posts.filter(post => post.index !== index);
    writeFileSync(POSTS_JSON, JSON.stringify(updated, null, 2));
    res.json({ deleted: posts.length - updated.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Fixed text-search configuration ────────────────────────────────────
app.get('/api/settings', (_req, res) => {
  res.json({
    embeddingModel: EMBEDDING_MODEL,
    rerankerModel: RERANK_MODEL,
    embeddingUrl: EMBEDDING_URL,
    rerankerUrl: RERANK_URL,
  });
});

function loadTextEmbeddings() {
  try {
    const mtimeMs = statSync(TEXT_EMB_JSON).mtimeMs;
    if (textEmbCache && textEmbCacheMtimeMs === mtimeMs) return textEmbCache;
    const value = JSON.parse(readFileSync(TEXT_EMB_JSON, 'utf8'));
    if (value.model !== EMBEDDING_MODEL || !value.embeddings) return null;
    textEmbCache = value;
    textEmbCacheMtimeMs = mtimeMs;
    return textEmbCache;
  } catch {
    return null;
  }
}

function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}

function searchText(post) {
  return [post.author, post.text].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [])
    .filter(token => token.length > 1);
}

function lexicalScores(query, posts) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return [];

  const documents = posts.map(post => {
    const tokens = tokenize(searchText(post));
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return { post, tokens, counts };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / (documents.length || 1);
  const documentFrequencies = new Map(queryTerms.map(term => [
    term,
    documents.reduce((count, doc) => count + (doc.counts.has(term) ? 1 : 0), 0),
  ]));
  const normalizedQuery = query.toLocaleLowerCase();

  return documents.map(doc => {
    let score = 0;
    for (const term of queryTerms) {
      const termFrequency = doc.counts.get(term) || 0;
      if (!termFrequency) continue;
      const documentFrequency = documentFrequencies.get(term) || 0;
      const inverseFrequency = Math.log(
        1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const denominator = termFrequency
        + 1.2 * (0.25 + 0.75 * doc.tokens.length / (averageLength || 1));
      score += inverseFrequency * (termFrequency * 2.2 / denominator);
    }
    if (normalizedQuery.length >= 4 && searchText(doc.post).toLocaleLowerCase().includes(normalizedQuery)) {
      score += 5;
    }
    return { post: doc.post, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
}

function reciprocalRankFusion(rankings) {
  const fused = new Map();
  for (const { items, weight } of rankings) {
    items.forEach((item, rank) => {
      const current = fused.get(item.post.index) || { post: item.post, score: 0 };
      current.score += weight / (60 + rank + 1);
      fused.set(item.post.index, current);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

async function embedQuery(query) {
  const instructedQuery = `Instruct: Retrieve LinkedIn posts that match what the user vaguely remembers.\nQuery: ${query}`;
  const response = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: instructedQuery }),
  });
  if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
  return (await response.json()).data[0].embedding;
}

async function rerank(query, candidates) {
  const response = await fetch(`${RERANK_URL}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents: candidates.map(item => searchText(item.post).slice(0, 12_000)),
      top_n: candidates.length,
    }),
  });
  if (!response.ok) throw new Error(`Reranker API ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (!Array.isArray(body.results)) throw new Error('Reranker API returned an invalid response');
  return body.results;
}

// ─── Text-only hybrid search ────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });

  const textIndex = loadTextEmbeddings();
  if (!textIndex) {
    return res.status(503).json({
      error: 'The R3 text index has not been generated yet. Run: npm run embed-only',
    });
  }

  try {
    await ensureSearchServices();
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const queryVector = await embedQuery(query);
    const vectorRanking = posts.map(post => {
      const vector = textIndex.embeddings[post.url || `index_${post.index}`];
      return vector ? { post, score: cosine(queryVector, vector) } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 100);
    const lexicalRanking = lexicalScores(query, posts).slice(0, 100);
    const candidates = reciprocalRankFusion([
      { items: vectorRanking, weight: 1 },
      { items: lexicalRanking, weight: 0.8 },
    ]).slice(0, 60);

    let finalRanking = candidates;
    let reranked = false;
    let warning = null;
    try {
      const rerankedItems = await rerank(query, candidates);
      const baseRank = new Map(candidates.map((item, rank) => [item.post.index, rank]));
      finalRanking = rerankedItems.map((item, rank) => {
        const candidate = candidates[item.index];
        if (!candidate) return null;
        return {
          post: candidate.post,
          relevance: item.relevance_score,
          score: 2 / (60 + rank + 1)
            + 1 / (60 + (baseRank.get(candidate.post.index) ?? candidates.length) + 1),
        };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      reranked = true;
    } catch (error) {
      warning = `Reranking unavailable; showing hybrid recall results: ${error.message}`;
      console.warn(`[search] ${warning}`);
    }

    const results = finalRanking.slice(0, 50);
    res.json({
      results: results.map(item => item.post.index),
      scores: Object.fromEntries(results.map(item => [item.post.index, item.relevance ?? item.score])),
      reranked,
      warning,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/search/status', (_req, res) => {
  const textIndex = loadTextEmbeddings();
  const postCount = textIndex ? Object.keys(textIndex.embeddings).length : 0;
  res.json({
    available: postCount > 0,
    postCount,
    embeddingModel: EMBEDDING_MODEL,
    rerankerModel: RERANK_MODEL,
    services: getSearchServiceStatus(),
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 4781;
const server = app.listen(PORT, () => {
  console.log(`[server] API running on http://localhost:${PORT}`);
});

app.post('/api/shutdown', (_req, res) => {
  res.json({ stopping: true });
  setTimeout(shutdown, 250);
});

let shuttingDown = false;

function stopActiveSync() {
  if (!syncProc?.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(syncProc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // It may already have exited.
  }
  syncProc = null;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopActiveSync();
  stopSearchServices();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
