/**
 * fix-duplicate-refs.js
 * Re-downloads images for posts whose mediaFiles clash with another post's files,
 * saves them under the correct post_NNNN_img_N.jpg names, and updates saved_posts.json.
 */

import { readFileSync, writeFileSync, existsSync, createWriteStream, copyFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTS_JSON = join(__dirname, 'output', 'saved_posts.json');
const MEDIA_DIR  = join(__dirname, 'output', 'media');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (existsSync(dest)) { resolve(dest); return; }
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
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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

  // Build map: filename -> list of post indices that reference it
  const fileRefs = {};
  for (const post of posts) {
    for (const mf of (post.mediaFiles || [])) {
      if (mf.file) {
        if (!fileRefs[mf.file]) fileRefs[mf.file] = [];
        fileRefs[mf.file].push(post.index);
      }
    }
  }

  const dups = Object.entries(fileRefs).filter(([, indices]) => indices.length > 1);
  console.log(`Found ${dups.length} duplicate file reference(s).`);

  if (dups.length === 0) {
    console.log('Nothing to fix!');
    return;
  }

  // For each duplicate, keep the file for the post with the matching index in the filename,
  // and re-download for all others (which got wrong files due to collision).
  const postsToFix = new Set();
  for (const [file, indices] of dups) {
    console.log(`\n  ${file} -> posts ${indices.join(', ')}`);
    // The file is named post_XXXX_img_N.jpg — find which post it belongs to by index
    const match = file.match(/post_(\d+)_/);
    const ownerIndex = match ? parseInt(match[1], 10) : null;
    for (const idx of indices) {
      if (idx !== ownerIndex) {
        postsToFix.add(idx);
        console.log(`  -> Post #${idx} needs its files re-downloaded`);
      }
    }
  }

  let changed = false;
  for (const postIndex of postsToFix) {
    const post = posts.find(p => p.index === postIndex);
    if (!post) continue;
    console.log(`\nFixing post #${postIndex} (${post.author})…`);

    for (let i = 0; i < post.mediaFiles.length; i++) {
      const mf = post.mediaFiles[i];
      if (!mf.file || !mf.originalUrl) continue;

      const ext = mf.file.split('.').pop() || 'jpg';
      const newFilename = `post_${String(postIndex).padStart(4, '0')}_img_${i}.${ext}`;
      const newDest = join(MEDIA_DIR, newFilename);

      if (mf.file === newFilename && existsSync(newDest)) {
        console.log(`  img ${i}: already correct (${newFilename})`);
        continue;
      }

      console.log(`  img ${i}: downloading from originalUrl -> ${newFilename}`);
      try {
        await downloadFile(mf.originalUrl, newDest);
        console.log(`  img ${i}: OK`);
        post.mediaFiles[i] = { ...mf, file: newFilename };
        changed = true;
      } catch (e) {
        console.error(`  img ${i}: FAILED — ${e.message}`);
        // Leave the old reference; we'll at least have the original URL
      }
    }
  }

  if (changed) {
    writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2));
    console.log('\nsaved_posts.json updated.');
  } else {
    console.log('\nNo changes written.');
  }

  // Final check
  const fileRefs2 = {};
  const posts2 = JSON.parse(readFileSync(POSTS_JSON, 'utf8'));
  for (const post of posts2) {
    for (const mf of (post.mediaFiles || [])) {
      if (mf.file) {
        if (!fileRefs2[mf.file]) fileRefs2[mf.file] = [];
        fileRefs2[mf.file].push(post.index);
      }
    }
  }
  const remaining = Object.entries(fileRefs2).filter(([, indices]) => indices.length > 1);
  console.log(`\nRemaining duplicates: ${remaining.length}`);
  if (remaining.length > 0) {
    for (const [f, is] of remaining) console.log(`  ${f} -> posts ${is.join(', ')}`);
  }
}

main().catch(console.error);
