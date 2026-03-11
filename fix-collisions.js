/**
 * Fix media file collisions caused by index-based naming in incremental sync.
 *
 * When new posts are prepended and indices shift, two different posts can end up
 * referencing the same filename. The newer post's download overwrites the older file.
 *
 * This script:
 * 1. Finds all duplicate file references
 * 2. Keeps the file for the post that last wrote it (lower index = newer post)
 * 3. Re-downloads the image for the other post with an activity-URN-based filename
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createWriteStream } from 'fs';
import { join, extname } from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const OUTPUT_JSON = './output/saved_posts.json';
const MEDIA_DIR = './output/media';

const CT_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

function downloadFile(url, dest) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.destroy();
          downloadFile(res.headers.location, dest).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); resolve(false); return; }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
        file.on('error', () => resolve(false));
      }).on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

async function run() {
  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  // Build map: filename -> [{postIndex, mediaFileIndex, post}]
  const refs = {};
  for (const p of posts) {
    for (let mi = 0; mi < (p.mediaFiles || []).length; mi++) {
      const mf = p.mediaFiles[mi];
      refs[mf.file] = refs[mf.file] || [];
      refs[mf.file].push({ postIndex: p.index, mfIdx: mi, post: p, mf });
    }
  }

  const dupes = Object.entries(refs).filter(([, v]) => v.length > 1);
  console.log(`Found ${dupes.length} collisions to fix.`);
  if (dupes.length === 0) return;

  let fixed = 0;
  for (const [filename, entries] of dupes) {
    // The post with the lowest index wrote the file last (it's the newest post)
    // We need to re-download for the other posts
    entries.sort((a, b) => a.postIndex - b.postIndex);
    const keeper = entries[0]; // newest post keeps the file
    const victims = entries.slice(1); // older posts need re-download

    for (const v of victims) {
      const actId = v.post.url?.match(/activity[:%3A]+(\d+)/)?.[1];
      if (!actId) {
        console.warn(`  [skip] Post ${v.postIndex} has no activity URL, can't generate unique name`);
        continue;
      }

      // Determine extension from the existing file or original URL
      const ext = extname(filename) || '.jpg';
      const type = v.mf.type === 'video' ? 'vid' : 'img';
      const newFilename = `act_${actId}_${type}_${v.mfIdx}${ext}`;
      const newPath = join(MEDIA_DIR, newFilename);

      if (existsSync(newPath)) {
        // Already downloaded with new name — just update the reference
        v.post.mediaFiles[v.mfIdx].file = newFilename;
        console.log(`  [exists] Post ${v.postIndex}: ${filename} -> ${newFilename}`);
        fixed++;
        continue;
      }

      // Re-download from originalUrl
      const ok = await downloadFile(v.mf.originalUrl, newPath);
      if (ok) {
        v.post.mediaFiles[v.mfIdx].file = newFilename;
        console.log(`  [fixed] Post ${v.postIndex}: ${filename} -> ${newFilename}`);
        fixed++;
      } else {
        console.warn(`  [fail] Post ${v.postIndex}: could not re-download ${v.mf.originalUrl}`);
      }
    }
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2), 'utf8');
  console.log(`\nDone. Fixed ${fixed}/${dupes.length} collisions.`);
}

run().catch(e => { console.error(e); process.exit(1); });
