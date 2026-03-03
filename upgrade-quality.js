/**
 * upgrade-quality.js
 *
 * Visits each saved post's LinkedIn page to download:
 *  - Full-resolution images (from srcset on the post detail page)
 *  - Original videos (HLS → MP4 via ffmpeg, or direct MP4 download)
 *
 * Run: node upgrade-quality.js
 * Progress saved every 5 posts — safe to stop and resume.
 */

import { chromium } from 'playwright';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  copyFileSync, readdirSync, statSync, unlinkSync, renameSync, createWriteStream,
} from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import 'dotenv/config';

// ─── Config ────────────────────────────────────────────────────────────────
const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const CHROME_PROFILE   = process.env.CHROME_PROFILE || 'Default';
const OUTPUT_JSON = './output/saved_posts.json';
const MEDIA_DIR   = './output/media';

const delay = (min, max) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

const CT_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

// ─── Network helpers ────────────────────────────────────────────────────────
/** Download URL into a Buffer; returns {buf, ct} or null on failure */
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

/** Stream a URL directly to a file on disk (for large files) */
function downloadToFile(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      const proto = url.startsWith('https') ? https : http;
      proto.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.linkedin.com/' },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.destroy();
          downloadToFile(res.headers.location, dest, redirects + 1).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); resolve(false); return; }
        const tmp = dest + '.tmp';
        const stream = createWriteStream(tmp);
        res.pipe(stream);
        stream.on('finish', () => { stream.close(); renameSync(tmp, dest); resolve(true); });
        stream.on('error', () => { resolve(false); });
      }).on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

/** Use ffmpeg to download an HLS stream to MP4 */
function ffmpegHLS(m3u8Url, dest) {
  const candidates = [
    'ffmpeg',
    `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`,
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  let bin = null;
  for (const c of candidates) {
    try { execSync(`"${c}" -version`, { stdio: 'pipe' }); bin = c; break; }
    catch {}
  }
  if (!bin) { console.warn('\n  [!] ffmpeg not found — skipping video download'); return false; }

  const r = spawnSync(bin, [
    '-y', '-i', m3u8Url,
    '-c', 'copy', '-movflags', '+faststart',
    dest,
  ], { stdio: 'pipe', timeout: 300_000 });
  return r.status === 0;
}

// ─── Asset ID extraction ────────────────────────────────────────────────────
/** Pull the unique asset ID from a LinkedIn CDN URL */
function getAssetId(url) {
  const m = (url || '').match(/\/dms\/(?:image|video|playback)\/[^\/]+\/([^\/]+)\//);
  return m ? m[1] : null;
}

// ─── Chrome profile copy ────────────────────────────────────────────────────
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
  const tempRoot = join(os.tmpdir(), `pw-uq-${Date.now()}`);
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

// ─── Image & video selectors ────────────────────────────────────────────────
const SKIP_IMG = [
  'profile-displayphoto', 'ghost', 'presence-entity__image', 'EntityPhoto',
  'static.licdn.com', 'liicons', 'data:', 'company-logo_100', 'company-logo_200',
  'company-logo_50', 'organizational-page-logo',
];

// ─── Per-post upgrade ───────────────────────────────────────────────────────
async function upgradePost(page, post, capturedVideos) {
  if (!post.url) return;
  capturedVideos.length = 0; // reset per post

  const prefix = `post_${String(post.index).padStart(4, '0')}`;

  // Intercept network requests for video URLs
  const onRequest = req => {
    const url = req.url();
    if (
      url.includes('.m3u8') ||
      url.includes('dms/playback') ||
      (url.includes('licdn.com') && url.includes('.mp4') && !url.includes('company'))
    ) {
      capturedVideos.push(url);
    }
  };
  page.on('request', onRequest);

  try {
    await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await delay(2500, 3500);

    // ── IMAGES ─────────────────────────────────────────────────────────────
    // Build asset ID → mediaFile map for existing images
    const assetMap = new Map();
    for (const mf of (post.mediaFiles || [])) {
      if (mf.type !== 'image') continue;
      const id = getAssetId(mf.originalUrl);
      if (id) assetMap.set(id, mf);
    }

    // Extract best-quality image URLs from post page via srcset
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

    // Match by asset ID and download if better quality
    for (const pi of pageImgs) {
      const id = getAssetId(pi.url);
      if (!id) continue;
      const mf = assetMap.get(id);
      if (!mf) continue;

      // Skip if not an upgrade
      const isSmall = mf.originalUrl.includes('shrink_480') ||
                      mf.originalUrl.includes('shrink_160') ||
                      mf.originalUrl.includes('shrink_100') ||
                      mf.originalUrl.includes('videocover-low') ||
                      mf.originalUrl.includes('videocover_350');
      if (!isSmall) continue;
      const isBetter = pi.w > 480 || (!pi.url.includes('shrink_480') && !pi.url.includes('shrink_160'));
      if (!isBetter) continue;

      const result = await fetchBuf(pi.url);
      if (!result) continue;

      const ext = CT_EXT[result.ct] || '.jpg';
      const newFile = mf.file.replace(/\.\w+$/, ext);
      const dest = join(MEDIA_DIR, newFile);
      writeFileSync(dest, result.buf);

      // Remove old file if filename changed
      if (newFile !== mf.file) {
        try { unlinkSync(join(MEDIA_DIR, mf.file)); } catch {}
      }
      mf.file = newFile;
      mf.originalUrl = pi.url;
    }

    // ── VIDEOS ─────────────────────────────────────────────────────────────
    const hasVidThumb = (post.mediaFiles || []).some(
      m => m.type === 'image' && m.originalUrl && (
        m.originalUrl.includes('videocover') ||
        m.originalUrl.includes('video-thumbnail') ||
        m.originalUrl.includes('feedshare-thumbnail')
      )
    );
    const alreadyHasVideo = (post.mediaFiles || []).some(m => m.type === 'video');

    if (hasVidThumb && !alreadyHasVideo) {
      // Try clicking play to trigger video load
      if (capturedVideos.length === 0) {
        await page.evaluate(() => {
          const btn = document.querySelector(
            'button[aria-label*="Play" i], .vjs-play-control, [data-test-play-button], ' +
            'button[data-urn*="video" i], .video-play-button'
          );
          if (btn) btn.click();
          document.querySelectorAll('video').forEach(v => {
            try { v.muted = true; v.play().catch(() => {}); } catch {}
          });
        }).catch(() => {});
        await delay(4000, 6000); // wait for HLS manifest request
      }

      // Prefer MP4 over m3u8 when available
      const mp4 = capturedVideos.find(u => u.includes('.mp4'));
      const m3u8 = capturedVideos.find(u => u.includes('.m3u8'));
      const videoUrl = mp4 || m3u8;

      if (videoUrl) {
        const vidIdx = (post.mediaFiles || []).filter(m => m.type === 'video').length;
        const dest = join(MEDIA_DIR, `${prefix}_vid_${vidIdx}.mp4`);
        const fname = `${prefix}_vid_${vidIdx}.mp4`;

        let ok = false;
        if (videoUrl.includes('.m3u8')) {
          process.stdout.write(' [ffmpeg HLS→MP4]');
          ok = ffmpegHLS(videoUrl, dest);
        } else {
          ok = await downloadToFile(videoUrl, dest);
        }

        if (ok) {
          post.mediaFiles = post.mediaFiles || [];
          post.mediaFiles.push({ type: 'video', file: fname, originalUrl: videoUrl });
        }
      }
    }

  } catch {
    // Keep existing data on any error
  } finally {
    page.off('request', onRequest);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  if (!existsSync(OUTPUT_JSON)) {
    console.error('[!] Run the scraper first (saved_posts.json not found).');
    process.exit(1);
  }
  mkdirSync(MEDIA_DIR, { recursive: true });

  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  // Which posts need work?
  const toUpgrade = posts.filter(p => {
    if (!p.url) return false;
    const mf = p.mediaFiles || [];
    const needsImgUpgrade = mf.some(m =>
      m.type === 'image' && (
        m.originalUrl.includes('shrink_480') ||
        m.originalUrl.includes('shrink_160') ||
        m.originalUrl.includes('shrink_100') ||
        m.originalUrl.includes('videocover-low') ||
        m.originalUrl.includes('videocover_350')
      )
    );
    const needsVideo =
      mf.some(m => m.type === 'image' && (
        m.originalUrl.includes('videocover') ||
        m.originalUrl.includes('feedshare-thumbnail')
      )) && !mf.some(m => m.type === 'video');
    return needsImgUpgrade || needsVideo;
  });

  console.log(`[*] ${posts.length} total posts, ${toUpgrade.length} need upgrading.`);
  if (toUpgrade.length === 0) { console.log('[+] Nothing to do.'); return; }

  console.log('[*] Opening Chrome. Do not close the window.\n');

  const tempRoot = copyProfile();
  const context = await chromium.launchPersistentContext(tempRoot, {
    channel: 'chrome',
    args: [`--profile-directory=${CHROME_PROFILE}`],
    headless: false,
    slowMo: 30,
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  const capturedVideos = [];

  // Ensure logged in
  await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await delay(2000, 3000);
  if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
    console.log('[!] Please log in in the browser (up to 2 min)...');
    await page.waitForURL(u => !u.includes('/login') && !u.includes('/checkpoint'),
      { timeout: 120_000 });
    console.log('[+] Logged in.');
  }

  let done = 0, imgUpgraded = 0, vidDownloaded = 0;

  for (const post of toUpgrade) {
    const prevImgs  = (post.mediaFiles || []).filter(m => m.type === 'image').map(m => m.originalUrl);
    const prevVids  = (post.mediaFiles || []).filter(m => m.type === 'video').length;

    process.stdout.write(`\r  [${done + 1}/${toUpgrade.length}] #${post.index}...          `);

    await upgradePost(page, post, capturedVideos);

    const newImgs = (post.mediaFiles || []).filter(m => m.type === 'image').map(m => m.originalUrl);
    const newVids = (post.mediaFiles || []).filter(m => m.type === 'video').length;

    if (newImgs.some((u, i) => u !== prevImgs[i])) imgUpgraded++;
    if (newVids > prevVids) vidDownloaded++;

    done++;
    if (done % 5 === 0) {
      writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
    }

    await delay(1500, 3000);
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
  await context.close();

  console.log(`\n\n[done] ${imgUpgraded} posts with better images, ${vidDownloaded} videos downloaded.`);
  console.log('[*] Restart the viewer: npm run viewer');
}

run().catch(e => { console.error('\n[error]', e.message); process.exit(1); });
