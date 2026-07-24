/**
 * Incrementally sync LinkedIn posts, then update the R3 text embedding index.
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import {
  EMBEDDING_URL,
  ensureEmbeddingService,
  stopEmbeddingService,
} from './search-runtime.js';

const args = process.argv.slice(2);
const VISIBLE = args.includes('--visible');
const EMBED_ONLY = args.includes('--embed-only');

function log(message) {
  console.log(`[sync-embed] ${message}`);
}

function runScript(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: process.cwd(),
      env: { ...process.env, R3_EMBEDDING_URL: EMBEDDING_URL, ...env },
      stdio: 'inherit',
    });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const startTime = Date.now();
  let ownsEmbeddingService = false;

  try {
    if (!EMBED_ONLY) {
      log('── Syncing new posts ──');
      await runScript('scraper-incremental.js', {
        HEADLESS: VISIBLE ? 'false' : 'true',
      });
    }

    log('── Starting R3 embedding service ──');
    const service = await ensureEmbeddingService();
    ownsEmbeddingService = service.started;

    log('── Updating text embeddings ──');
    await runScript('generate-embeddings.js');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`All done in ${elapsed}s`);
  } finally {
    if (ownsEmbeddingService) {
      log('Stopping temporary embedding service...');
      stopEmbeddingService();
    }
  }
}

main().catch(error => {
  console.error(`[sync-embed] Fatal: ${error.message}`);
  process.exit(1);
});
