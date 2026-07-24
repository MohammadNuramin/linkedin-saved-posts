/**
 * Manages the GPU-backed R3 text-search service.
 *
 * The service loads R3-Embedding at startup and loads R3-Rerank lazily on the
 * first search. A single PyTorch CUDA process keeps memory use much lower than
 * running two vLLM servers.
 */

import 'dotenv/config';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

export const EMBEDDING_MODEL = process.env.R3_EMBEDDING_MODEL || 'tencent/R3-embedding-0.6b';
export const RERANK_MODEL = process.env.R3_RERANK_MODEL || 'tencent/R3-rerank-0.6b';
export const SEARCH_PORT = process.env.R3_SEARCH_PORT || process.env.R3_EMBEDDING_PORT || '8691';
export const EMBEDDING_URL = (process.env.R3_EMBEDDING_URL || `http://localhost:${SEARCH_PORT}`).replace(/\/$/, '');
export const RERANK_URL = (process.env.R3_RERANK_URL || EMBEDDING_URL).replace(/\/$/, '');

const CONTAINER_NAME = 'linkedin-r3-search';
const SERVICE_IMAGE = process.env.R3_SERVICE_IMAGE || 'linkedin-r3-search:local';
const CACHE_VOLUME = process.env.R3_MODEL_CACHE_VOLUME || 'linkedin-r3-model-cache';
const HEALTH_TIMEOUT_MS = Number(process.env.R3_HEALTH_TIMEOUT_MS || 600_000);
const HEALTH_POLL_MS = 2_000;

function log(message) {
  console.log(`[search-runtime] ${message}`);
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout,
  });
}

function containerStatus() {
  try {
    return docker(['inspect', '-f', '{{.State.Status}}', CONTAINER_NAME]).trim();
  } catch {
    return null;
  }
}

function containerLogs() {
  try {
    return docker(['logs', '--tail', '100', CONTAINER_NAME]).trim();
  } catch (error) {
    return error.stderr?.toString().trim() || error.message;
  }
}

function removeContainer() {
  if (!containerStatus()) return;
  try {
    docker(['rm', '-f', CONTAINER_NAME]);
  } catch {
    // Best-effort cleanup.
  }
}

function imageExists() {
  try {
    docker(['image', 'inspect', SERVICE_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

function ensureDockerRunning() {
  try {
    docker(['info']);
    return;
  } catch {
    log('Starting Docker Desktop...');
  }

  const child = spawn('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

async function waitForDocker() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      docker(['info']);
      return;
    } catch {
      await new Promise(resolvePromise => setTimeout(resolvePromise, HEALTH_POLL_MS));
    }
  }
  throw new Error('Docker Desktop did not become ready within 2 minutes');
}

function ensureServiceImage() {
  if (imageExists()) return;
  log('Building the GPU search service image (first run only)...');
  docker([
    'build',
    '-f', 'search-service/Dockerfile',
    '-t', SERVICE_IMAGE,
    'search-service',
  ], { inherit: true });
}

async function waitForService() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = containerStatus();
    if (status && status !== 'running' && status !== 'created') {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      throw new Error(`${CONTAINER_NAME} exited while starting:\n${containerLogs()}`);
    }
    try {
      const response = await fetch(`${EMBEDDING_URL}/health`);
      if (response.ok) return;
    } catch {
      // Model is still downloading or loading.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, HEALTH_POLL_MS));
  }
  throw new Error(`${CONTAINER_NAME} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

let startPromise = null;

export async function ensureSearchServices() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    ensureDockerRunning();
    await waitForDocker();
    ensureServiceImage();

    if (containerStatus() === 'running') {
      await waitForService();
      return { started: false };
    }
    removeContainer();

    log(`Starting GPU search service on port ${SEARCH_PORT}...`);
    docker([
      'run', '-d',
      '--name', CONTAINER_NAME,
      '--gpus', 'all',
      '-p', `127.0.0.1:${SEARCH_PORT}:8000`,
      '-v', `${CACHE_VOLUME}:/models`,
      '-e', 'HF_HUB_DISABLE_XET=1',
      '-e', `R3_EMBEDDING_MODEL=${EMBEDDING_MODEL}`,
      '-e', `R3_RERANK_MODEL=${RERANK_MODEL}`,
      SERVICE_IMAGE,
    ]);
    await waitForService();
    log('R3 embedding service is ready; reranker will load on first search.');
    return { started: true };
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export const ensureEmbeddingService = ensureSearchServices;

export function stopSearchServices() {
  removeContainer();
}

export const stopEmbeddingService = stopSearchServices;

export function getSearchServiceStatus() {
  const status = containerStatus();
  return { embedding: status, reranker: status };
}

async function runCli() {
  const command = process.argv[2] || 'start';
  if (command === 'start' || command === 'start-embedding') {
    await ensureSearchServices();
  } else if (command === 'stop') {
    stopSearchServices();
  } else if (command === 'status') {
    console.log(JSON.stringify(getSearchServiceStatus(), null, 2));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  runCli().catch(error => {
    console.error(`[search-runtime] Fatal: ${error.message}`);
    process.exit(1);
  });
}
