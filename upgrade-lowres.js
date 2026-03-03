/**
 * upgrade-lowres.js
 *
 * Targeted upgrade: visits only the ~32 posts that still have shrink_480/100
 * images and downloads the best-resolution version from the post page srcset.
 *
 * Run: node upgrade-lowres.js
 * Safe to stop and resume — skips posts where originalUrl no longer contains
 * a low-res indicator (already upgraded).
 */

import { chromium } from 'playwright';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  copyFileSync, readdirSync, statSync, unlinkSync, renameSync,
} from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { execSync } from 'child_process';
import 'dotenv/config';

const CHROME_USER_DATA = 'C:/Users/Aveno/AppData/Local/Google/Chrome/User Data';
const CHROME_PROFILE   = 'Profile 2';
const OUTPUT_JSON = './output/saved_posts.json';
const MEDIA_DIR   = './output/media';

const SMALL_PATTERNS = ['shrink_480', 'shrink_160', 'shrink_100'];
const SKIP_IMG = [
  'profile-displayphoto', 'ghost', 'presence-entity__image', 'EntityPhoto',
  'static.licdn.com', 'liicons', 'data:', 'company-logo_100', 'company-logo_200',
  'company-logo_50', 'organizational-page-logo',
];

const delay = (min, max) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

function fetchBuf(url, redirects = 0) {
  if (redirects > 5) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const proto = url.startsWith('https') ? https : http;
      proto.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.linkedin.com/' },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.destroy();
          fetchBuf(res.headers.location, redirects + 1).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); resolve(null); return; }
        const ct = (res.headers['content-type'] || '').split(';')[0].trim();
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), ct }));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

function getAssetId(url) {
  const m = (url || '').match(/\/dms\/(?:image|video|playback)\/[^\/]+\/([^\/]+)\//);
  return m ? m[1] : null;
}

const SKIP_DIRS  = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache'];
const SKIP_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function copyLockedFile(src, dest) {
  const ps = `
    $s = '${src.replace(/\\/g, '\\\\').replace(/'/g, "''")}';
    $d = '${dest.replace(/\\/g, '\\\\').replace(/'/g, "''")}';
    New-Item -ItemType Directory -Path (Split-Path $d) -Force | Out-Null;
    try {
      $fs = [System.IO.File]::Open($s, 'Open', 'Read', 'ReadWrite');
      $fd = [System.IO.File]::Create($d);
      $fs.CopyTo($fd); $fs.Close(); $fd.Close();
    } catch {}
  `.replace(/\n\s*/g, ' ');
  try { execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: 'pipe' }); }
  catch {}
}

function copyProfile() {
  const src = join(CHROME_USER_DATA, CHROME_PROFILE);
  const tempRoot = join(os.tmpdir(), `pw-lr-${Date.now()}`);
  const tempProf = join(tempRoot, CHROME_PROFILE);
  mkdirSync(tempProf, { recursive: true });
  console.log('[*] Copying Chrome profile...');

  function copyDir(s, d) {
    mkdirSync(d, { recursive: true });
    let entries; try { entries = readdirSync(s); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.includes(e) || SKIP_FILES.includes(e)) continue;
      const sp = join(s, e), dp = join(d, e);
      try {
        if (statSync(sp).isDirectory()) copyDir(sp, dp);
        else try { copyFileSync(sp, dp); } catch {}
      } catch {}
    }
  }
  copyDir(src, tempProf);

  const networkSrc = join(src, 'Network');
  if (existsSync(networkSrc)) {
    mkdirSync(join(tempProf, 'Network'), { recursive: true });
    for (const f of ['Cookies', 'Cookies-journal'])
      copyLockedFile(join(networkSrc, f), join(tempProf, 'Network', f));
  }
  for (const f of ['Web Data', 'Login Data'])
    copyLockedFile(join(src, f), join(tempProf, f));
  for (const f of SKIP_FILES) { try { unlinkSync(join(tempProf, f)); } catch {} }

  console.log('[+] Profile ready.\n');
  return tempRoot;
}

const CT_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
};

async function main() {
  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  // Find posts that still have low-res images
  const targets = posts.filter(p =>
    p.url && (p.mediaFiles || []).some(mf =>
      mf.type === 'image' && SMALL_PATTERNS.some(s => (mf.originalUrl || '').includes(s))
    )
  );

  console.log(`Found ${targets.length} posts with low-res images to upgrade.\n`);
  if (targets.length === 0) { console.log('Nothing to do!'); return; }

  const tempRoot = copyProfile();

  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--profile-directory=' + CHROME_PROFILE],
  });

  const context = await browser.newContext({
    userDataDir: tempRoot,
  });
  const page = await context.newPage();

  let upgraded = 0;
  let failed   = 0;

  for (let i = 0; i < targets.length; i++) {
    const post = targets[i];
    // Re-fetch from the live posts array (in case earlier iterations modified it)
    const livePost = posts.find(p => p.index === post.index);
    if (!livePost) continue;

    // Skip if already upgraded (e.g. resumed run)
    const stillLowRes = (livePost.mediaFiles || []).some(mf =>
      mf.type === 'image' && SMALL_PATTERNS.some(s => (mf.originalUrl || '').includes(s))
    );
    if (!stillLowRes) { console.log(`[${i+1}/${targets.length}] #${post.index} already upgraded — skip`); continue; }

    process.stdout.write(`[${i+1}/${targets.length}] #${post.index} ${post.url?.slice(0, 60)}...`);

    try {
      await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await delay(2500, 3500);

      // Build assetId → mediaFile map
      const assetMap = new Map();
      for (const mf of (livePost.mediaFiles || [])) {
        if (mf.type !== 'image') continue;
        const id = getAssetId(mf.originalUrl);
        if (id) assetMap.set(id, mf);
      }

      // Extract best quality image URLs from srcset
      const pageImgs = await page.evaluate((SKIP) => {
        const out = [];
        document.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src') || img.getAttribute('data-delayed-url') || '';
          if (!src || SKIP.some(s => src.includes(s))) return;
          if (!src.includes('licdn.com')) return;

          let best = src, bestW = 0;
          const srcset = img.getAttribute('srcset') || '';
          if (srcset) {
            srcset.split(',').forEach(entry => {
              const [url, wStr] = entry.trim().split(/\s+/);
              const w = parseInt(wStr) || 0;
              if (url && url.startsWith('http') && w > bestW) { bestW = w; best = url; }
            });
          }
          out.push({ url: best, w: bestW });
        });
        return out;
      }, SKIP_IMG).catch(() => []);

      let postUpgraded = 0;
      for (const pi of pageImgs) {
        const id = getAssetId(pi.url);
        if (!id) continue;
        const mf = assetMap.get(id);
        if (!mf) continue;

        const isBetter = pi.w > 480 || (!pi.url.includes('shrink_480') && !pi.url.includes('shrink_160'));
        if (!isBetter) continue;

        const result = await fetchBuf(pi.url);
        if (!result) continue;

        const ext = CT_EXT[result.ct] || '.jpg';
        const newFile = mf.file.replace(/\.\w+$/, ext);
        const dest = join(MEDIA_DIR, newFile);
        writeFileSync(dest, result.buf);

        if (newFile !== mf.file) {
          try { unlinkSync(join(MEDIA_DIR, mf.file)); } catch {}
        }
        mf.file = newFile;
        mf.originalUrl = pi.url;
        postUpgraded++;
      }

      if (postUpgraded > 0) {
        upgraded++;
        console.log(` ✓ upgraded ${postUpgraded} image(s)`);
      } else {
        console.log(` — no better version found`);
      }
    } catch (e) {
      failed++;
      console.log(` ✗ ${e.message.split('\n')[0]}`);
    }

    // Save progress every 5 posts
    if ((i + 1) % 5 === 0) {
      writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
      console.log('  [saved progress]');
    }
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
  await browser.close();
  try { unlinkSync(join(os.tmpdir(), tempRoot.split(/[\\/]/).pop())); } catch {}

  console.log(`\nDone. Upgraded: ${upgraded}  Not improved: ${targets.length - upgraded - failed}  Failed: ${failed}`);
}

main().catch(console.error);
