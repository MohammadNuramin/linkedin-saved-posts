/**
 * Fix images for posts added by incremental sync.
 *
 * The incremental scraper's downloadFile() skipped downloads when a file with
 * the same name already existed — but the existing file belonged to a different post.
 * This script re-downloads images for all recently-added posts using unique act_ filenames.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
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

function downloadFile(url, destPath) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.destroy();
          downloadFile(res.headers.location, destPath).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); resolve(false); return; }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
        file.on('error', () => resolve(false));
      }).on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

async function run() {
  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  // Find posts added by incremental sync: they have post_ prefix files where
  // the file number doesn't match the post index AND the file was created by
  // a sync run (not the original scrape). We identify them by having recent
  // timestamps or file numbers > original post count.
  //
  // Simpler heuristic: any post whose file starts with post_ and the number
  // in the filename > 1100 (near the original count of ~1163) is suspect.
  // But more reliable: just check ALL posts with post_ prefix files where
  // file number != index, and re-download those with act_ prefix if the
  // originalUrl is still valid.

  // Focus on the first ~70 posts (all posts added by incremental syncs)
  // since original posts (deeper in array) have correct file content.
  const SCAN_RANGE = 70; // check more than needed to be safe

  let fixed = 0, failed = 0, skipped = 0;

  for (let pi = 0; pi < Math.min(SCAN_RANGE, posts.length); pi++) {
    const post = posts[pi];
    if (!post.mediaFiles || post.mediaFiles.length === 0) continue;

    const actId = post.url?.match(/activity[:%3A]+(\d+)/)?.[1];
    if (!actId) { skipped++; continue; }

    let changed = false;
    for (let mi = 0; mi < post.mediaFiles.length; mi++) {
      const mf = post.mediaFiles[mi];

      // Skip if already using act_ prefix (already fixed)
      if (mf.file.startsWith('act_')) continue;

      // Check if the file number matches the post index
      const fileMatch = mf.file.match(/^post_(\d+)_/);
      if (fileMatch && parseInt(fileMatch[1]) === post.index) continue; // correct

      // This file is from a different post — re-download with unique name
      const type = mf.type === 'video' ? 'vid' : 'img';
      const ext = extname(mf.file) || '.jpg';
      const newFilename = `act_${actId}_${type}_${mi}${ext}`;
      const newPath = join(MEDIA_DIR, newFilename);

      if (existsSync(newPath) && statSync(newPath).size > 100) {
        // Already downloaded
        mf.file = newFilename;
        changed = true;
        console.log(`  [exists] Post ${post.index}: ${mf.file} -> ${newFilename}`);
        fixed++;
        continue;
      }

      const ok = await downloadFile(mf.originalUrl, newPath);
      if (ok && existsSync(newPath) && statSync(newPath).size > 100) {
        const oldFile = mf.file;
        mf.file = newFilename;
        changed = true;
        console.log(`  [fixed] Post ${post.index} (${post.author}): ${oldFile} -> ${newFilename}`);
        fixed++;
      } else {
        console.warn(`  [fail] Post ${post.index} (${post.author}): ${mf.originalUrl.slice(0, 80)}`);
        failed++;
      }
    }
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2), 'utf8');
  console.log(`\nDone. Fixed: ${fixed}, Failed: ${failed}, Skipped: ${skipped}`);
}

run().catch(e => { console.error(e); process.exit(1); });
