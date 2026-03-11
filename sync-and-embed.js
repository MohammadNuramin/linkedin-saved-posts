/**
 * Orchestrator: Sync LinkedIn posts → Generate embeddings (local vLLM via Docker).
 *
 * Flow:
 *   1. Start local vLLM Docker container (Qwen3-VL-Embedding-2B)
 *   2. Wait for it to be healthy
 *   3. Run scraper-incremental.js to fetch new posts
 *   4. Run generate-embeddings.js to embed new posts
 *   5. Stop & remove the Docker container
 *
 * Usage:
 *   node sync-and-embed.js              # headless sync + embed
 *   node sync-and-embed.js --visible    # visible browser + embed
 *   node sync-and-embed.js --embed-only # skip sync, just embed
 *
 * Requires: Docker Desktop with GPU support (nvidia-container-toolkit)
 */

import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────────────────────
const CONTAINER_NAME = 'linkedin-embeddings';
const VLLM_IMAGE = 'vllm/vllm-openai:latest';
const VLLM_PORT = process.env.VLLM_PORT || '8691';
const VLLM_URL = `http://localhost:${VLLM_PORT}`;
const HEALTH_TIMEOUT_MS = 180_000; // 3 min max to wait for model load
const HEALTH_POLL_MS = 3_000;

// Read model from settings
function getModel() {
  try {
    const s = JSON.parse(readFileSync('./output/settings.json', 'utf8'));
    return s.embeddingModel || 'Qwen/Qwen3-VL-Embedding-2B';
  } catch {
    return 'Qwen/Qwen3-VL-Embedding-2B';
  }
}

const MODEL = process.env.EMBEDDING_MODEL || getModel();
const args = process.argv.slice(2);
const VISIBLE = args.includes('--visible');
const EMBED_ONLY = args.includes('--embed-only');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[sync-embed] ${msg}`); }

function isContainerRunning() {
  try {
    const out = execSync(
      `docker inspect -f "{{.State.Running}}" ${CONTAINER_NAME}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function containerExists() {
  try {
    execSync(`docker inspect ${CONTAINER_NAME}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function removeContainer() {
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { /* doesn't exist, fine */ }
}

function ensureDockerRunning() {
  try {
    execSync('docker info', { stdio: ['pipe', 'pipe', 'pipe'] });
    return;
  } catch { /* Docker daemon not running */ }

  log('Starting Docker Desktop...');
  // Start Docker Desktop in background
  try {
    spawn('cmd', ['/c', 'start', '', '/b', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    throw new Error(`Failed to start Docker Desktop: ${e.message}`);
  }

  // Wait for Docker daemon
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      execSync('docker info', { stdio: ['pipe', 'pipe', 'pipe'] });
      log('Docker Desktop is ready.');
      return;
    } catch { /* not ready yet */ }
    execSync('timeout /t 3 /nobreak >nul 2>&1', { shell: 'cmd.exe' });
  }
  throw new Error('Docker Desktop did not start within 2 minutes');
}

// ─── Docker container lifecycle ──────────────────────────────────────────────
function startContainer() {
  if (isContainerRunning()) {
    log(`Container "${CONTAINER_NAME}" already running.`);
    return;
  }

  // Remove stale stopped container
  if (containerExists()) removeContainer();

  log(`Starting vLLM container with model: ${MODEL}`);
  log(`Image: ${VLLM_IMAGE}, Port: ${VLLM_PORT}`);

  execSync([
    'docker run -d',
    `--name ${CONTAINER_NAME}`,
    '--gpus all',
    '--ipc=host',
    `-p ${VLLM_PORT}:8000`,
    VLLM_IMAGE,
    `--model ${MODEL}`,
    '--task embed',
    '--max-model-len 4096',
    '--trust-remote-code',
  ].join(' '), { stdio: 'inherit' });
}

async function waitForHealth() {
  log('Waiting for vLLM to load model...');
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${VLLM_URL}/health`);
      if (r.ok) {
        log('vLLM is healthy ✓');
        return;
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
  }

  throw new Error(`vLLM did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

function stopContainer() {
  if (!isContainerRunning()) return;
  log(`Stopping container "${CONTAINER_NAME}"...`);
  execSync(`docker stop ${CONTAINER_NAME}`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  removeContainer();
  log('Container stopped and removed.');
}

// ─── Run child scripts ───────────────────────────────────────────────────────
function runScript(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: process.cwd(),
      env: { ...process.env, VLLM_URL, ...env },
      stdio: 'inherit',
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  try {
    // 1. Ensure Docker is running
    ensureDockerRunning();

    // 2. Start vLLM container
    startContainer();
    await waitForHealth();

    // 3. Sync new posts (unless --embed-only)
    if (!EMBED_ONLY) {
      log('── Syncing new posts ──');
      await runScript('scraper-incremental.js', {
        HEADLESS: VISIBLE ? 'false' : 'true',
      });
    }

    // 4. Generate embeddings for any un-embedded posts
    log('── Generating embeddings ──');
    await runScript('generate-embeddings.js');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`✓ All done in ${elapsed}s`);

  } finally {
    // 5. Always stop the container
    stopContainer();
  }
}

main().catch(e => {
  console.error(`[sync-embed] Fatal: ${e.message}`);
  // Make sure container is cleaned up even on error
  try { stopContainer(); } catch { /* best effort */ }
  process.exit(1);
});
