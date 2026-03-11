/**
 * API server for the LinkedIn Saved Posts viewer.
 * Exposes scheduler control and sync status to the frontend UI.
 * Run: node server.js  (starts on port 4781)
 */

import 'dotenv/config';
import express from 'express';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Allow Vite dev server to call us
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const TASK_NAME = 'LinkedIn Saved Posts Daily Sync';
const SYNC_LOG  = join(__dirname, 'output', 'sync-log.json');

// ─── Sync log ──────────────────────────────────────────────────────────────
app.get('/api/sync-log', (_req, res) => {
  try {
    const log = JSON.parse(readFileSync(SYNC_LOG, 'utf8'));
    res.json(log);
  } catch {
    res.json([]);
  }
});

// ─── Scheduler status ──────────────────────────────────────────────────────
app.get('/api/scheduler', (_req, res) => {
  try {
    const out = execSync(
      `schtasks /query /tn "${TASK_NAME}" /fo LIST`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const nextRun  = out.match(/Next Run Time:\s*(.+)/)?.[1]?.trim() ?? null;
    const lastRun  = out.match(/Last Run Time:\s*(.+)/)?.[1]?.trim() ?? null;
    const status   = out.match(/Status:\s*(.+)/)?.[1]?.trim() ?? null;
    // Extract the time from the task XML for the picker
    const timeMatch = out.match(/(\d{1,2}):(\d{2}):00\s*(AM|PM)/i);
    let hour = 8, minute = 0;
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      if (timeMatch[3].toUpperCase() === 'PM' && h !== 12) h += 12;
      if (timeMatch[3].toUpperCase() === 'AM' && h === 12) h = 0;
      hour = h; minute = m;
    }
    res.json({ enabled: true, nextRun, lastRun, status, hour, minute });
  } catch {
    res.json({ enabled: false, nextRun: null, lastRun: null, status: null, hour: 8, minute: 0 });
  }
});

// ─── Setup / update scheduler ──────────────────────────────────────────────
app.post('/api/scheduler', (req, res) => {
  const { hour = 8, minute = 0 } = req.body;
  try {
    execSync(`node setup-scheduler.js`, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SYNC_HOUR: String(hour), SYNC_MINUTE: String(minute) },
    });
    res.json({ success: true });
  } catch (e) {
    const detail = (e.stderr || e.stdout || '').toString().trim();
    res.status(500).json({ error: detail || e.message });
  }
});

// ─── Remove scheduler ──────────────────────────────────────────────────────
app.delete('/api/scheduler', (_req, res) => {
  try {
    execSync(`node setup-scheduler.js --remove`, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    res.json({ success: true });
  } catch (e) {
    const detail = (e.stderr || e.stdout || '').toString().trim();
    res.status(500).json({ error: detail || e.message });
  }
});

// ─── Manual sync ──────────────────────────────────────────────────────────
let syncProc = null;
let syncLog  = [];   // live output lines

app.post('/api/sync', (_req, res) => {
  if (syncProc) {
    return res.status(409).json({ error: 'Sync already running' });
  }
  syncLog = [];
  // Use the orchestrator: sync → Docker vLLM → embed → stop Docker
  syncProc = spawn('node', ['sync-and-embed.js', '--visible'], {
    cwd: __dirname,
    env: { ...process.env },
  });
  const onData = (d) => {
    syncLog.push(d.toString());
    // Clear embedding caches when embeddings are regenerated
    if (d.toString().includes('Saved') && d.toString().includes('embeddings')) {
      textEmbCache = null;
      imgEmbCache = null;
    }
  };
  syncProc.stdout.on('data', onData);
  syncProc.stderr.on('data', onData);
  syncProc.on('close', () => { syncProc = null; });
  res.json({ started: true });
});

// ─── Sync status / live output ─────────────────────────────────────────────
app.get('/api/sync/status', (_req, res) => {
  res.json({ running: syncProc !== null, output: syncLog.join('') });
});

// ─── Delete posts ─────────────────────────────────────────────────────────
const POSTS_JSON = join(__dirname, 'output', 'saved_posts.json');

// Must be before /api/posts/:index so "author" isn't captured as the param
app.delete('/api/posts/author', (req, res) => {
  try {
    const { author } = req.body;
    if (!author) return res.status(400).json({ error: 'author required' });
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const updated = posts.filter(p => p.author !== author);
    writeFileSync(POSTS_JSON, JSON.stringify(updated, null, 2));
    res.json({ deleted: posts.length - updated.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/posts/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const updated = posts.filter(p => p.index !== index);
    writeFileSync(POSTS_JSON, JSON.stringify(updated, null, 2));
    res.json({ deleted: posts.length - updated.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────
const SETTINGS_JSON = join(__dirname, 'output', 'settings.json');
const AVAILABLE_MODELS = [
  { id: 'Qwen/Qwen3-VL-Embedding-2B', label: 'Qwen3-VL-Embedding 2B', vram: '~5GB', textBatch: 32, imgConcurrency: 16 },
  { id: 'Qwen/Qwen3-VL-Embedding-8B', label: 'Qwen3-VL-Embedding 8B', vram: '~18GB', textBatch: 16, imgConcurrency: 6 },
];
const DEFAULT_MODEL = 'Qwen/Qwen3-VL-Embedding-2B';

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_JSON, 'utf8')); }
  catch { return {}; }
}

function saveSettings(s) {
  writeFileSync(SETTINGS_JSON, JSON.stringify(s, null, 2), 'utf8');
}

app.get('/api/settings', (_req, res) => {
  const s = loadSettings();
  res.json({
    embeddingModel: s.embeddingModel || DEFAULT_MODEL,
    availableModels: AVAILABLE_MODELS,
    vllmUrl: (process.env.VLLM_URL || 'http://localhost:8691').replace(/\/$/, ''),
  });
});

app.post('/api/settings', (req, res) => {
  const s = loadSettings();
  if (req.body.embeddingModel) {
    const valid = AVAILABLE_MODELS.find(m => m.id === req.body.embeddingModel);
    if (!valid) return res.status(400).json({ error: 'Invalid model' });
    s.embeddingModel = req.body.embeddingModel;
    // Clear embedding caches so they reload on next search
    textEmbCache = null;
    imgEmbCache = null;
  }
  saveSettings(s);
  res.json({ success: true, settings: s });
});

// ─── Semantic search (multimodal embeddings) ────────────────────────────
const TEXT_EMB_JSON = join(__dirname, 'output', 'embeddings.json');
const IMG_EMB_JSON = join(__dirname, 'output', 'embeddings-img.json');
const VLLM_URL = (process.env.VLLM_URL || 'http://localhost:8691').replace(/\/$/, '');

function getVllmModel() {
  const s = loadSettings();
  return s.embeddingModel || DEFAULT_MODEL;
}

let textEmbCache = null;
let imgEmbCache = null;

function loadTextEmb() {
  if (textEmbCache) return textEmbCache;
  try { textEmbCache = JSON.parse(readFileSync(TEXT_EMB_JSON, 'utf8')); return textEmbCache; }
  catch { return null; }
}

function loadImgEmb() {
  if (imgEmbCache) return imgEmbCache;
  try { imgEmbCache = JSON.parse(readFileSync(IMG_EMB_JSON, 'utf8')); return imgEmbCache; }
  catch { return null; }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'query required' });

  const textEmb = loadTextEmb();
  const imgEmb = loadImgEmb();
  if (!textEmb && !imgEmb) return res.status(500).json({ error: 'No embeddings. Run: node generate-embeddings.js' });

  try {
    const model = getVllmModel();
    const vRes = await fetch(`${VLLM_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: q }),
    });
    if (!vRes.ok) throw new Error(`vLLM API ${vRes.status}: ${await vRes.text()}`);
    const queryVec = (await vRes.json()).data[0].embedding;

    // Score all posts — best of text score and image score
    const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
    const scored = posts
      .map(p => {
        const key = p.url || `index_${p.index}`;
        const tVec = textEmb?.[key];
        const iVec = imgEmb?.[key];
        if (!tVec && !iVec) return null;
        const tScore = tVec ? cosine(queryVec, tVec) : 0;
        const iScore = iVec ? cosine(queryVec, iVec) : 0;
        return { index: p.index, score: Math.max(tScore, iScore) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    res.json({ results: scored.map(s => s.index), scores: Object.fromEntries(scored.map(s => [s.index, s.score])) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search/status', (_req, res) => {
  const textEmb = loadTextEmb();
  const imgEmb = loadImgEmb();
  const tCount = textEmb ? Object.keys(textEmb).length : 0;
  const iCount = imgEmb ? Object.keys(imgEmb).length : 0;
  res.json({
    available: tCount > 0 || iCount > 0,
    postCount: Math.max(tCount, iCount),
    model: getVllmModel(),
  });
});

// ─── Health ───────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 4781;
app.listen(PORT, () => {
  console.log(`[server] API running on http://localhost:${PORT}`);
});
