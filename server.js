/**
 * API server for the LinkedIn Saved Posts viewer.
 * Exposes scheduler control and sync status to the frontend UI.
 * Run: node server.js  (starts on port 3001)
 */

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
  syncProc = spawn('node', ['scraper-incremental.js'], {
    cwd: __dirname,
    env: { ...process.env, HEADLESS: 'false' },
  });
  const onData = (d) => syncLog.push(d.toString());
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

// ─── Health ───────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`[server] API running on http://localhost:${PORT}`);
});
