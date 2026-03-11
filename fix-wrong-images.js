/**
 * fix-wrong-images.js
 *
 * Re-downloads images for new sync posts whose file references
 * point to files belonging to different (old) posts.
 */

import { readFileSync, writeFileSync, existsSync, createWriteStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTS_JSON = join(__dirname, 'output', 'saved_posts.json');
const MEDIA_DIR  = join(__dirname, 'output', 'media');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = createWriteStream(dest);
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (e) => { file.close(); reject(e); });
  });
}

async function main() {
  const posts = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));

  // Find max existing file index
  let maxFileIdx = 0;
  for (const p of posts) {
    for (const mf of (p.mediaFiles || [])) {
      const m = mf.file.match(/post_(\d+)_/);
      if (m) maxFileIdx = Math.max(maxFileIdx, parseInt(m[1], 10));
    }
  }

  // Find new sync posts with wrong file references
  const broken = [];
  for (const p of posts) {
    if (!p.mediaFiles || !p.mediaFiles.length) continue;
    for (const mf of p.mediaFiles) {
      const m = mf.file.match(/post_(\d+)_/);
      if (!m) continue;
      const fileIdx = parseInt(m[1], 10);
      if (p.index !== fileIdx && fileIdx > p.index + 100) {
        broken.push({ post: p, mf });
      }
    }
  }

  console.log(`Found ${broken.length} media files to fix across ${new Set(broken.map(b => b.post.index)).size} posts.\n`);
  if (broken.length === 0) { console.log('Nothing to fix!'); return; }

  // Use indices starting after max to avoid any collisions
  let nextIdx = maxFileIdx + 1;
  let fixed = 0;

  for (const { post, mf } of broken) {
    const ext = mf.file.split('.').pop() || 'jpg';
    const imgNum = mf.file.match(/_img_(\d+)\./)?.[1] || mf.file.match(/_vid_(\d+)\./)?.[1] || '0';
    const type = mf.type === 'video' ? 'vid' : 'img';
    const newFilename = `post_${String(nextIdx).padStart(4, '0')}_${type}_${imgNum}.${ext}`;
    const dest = join(MEDIA_DIR, newFilename);

    process.stdout.write(`  #${post.index} ${mf.file} → ${newFilename} ... `);

    try {
      await downloadFile(mf.originalUrl, dest);
      mf.file = newFilename;
      fixed++;
      nextIdx++;
      console.log('OK');
    } catch (e) {
      nextIdx++;
      console.log(`FAILED (${e.message})`);
    }
  }

  writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2));
  console.log(`\nDone. Fixed ${fixed}/${broken.length} files. saved_posts.json updated.`);
}

main().catch(console.error);
