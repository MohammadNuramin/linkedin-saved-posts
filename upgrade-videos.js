/**
 * upgrade-videos.js
 *
 * Downloads actual video files for posts that have video thumbnails but no video.
 * Targets only the ~146 video posts — does not re-process already-done posts.
 *
 * Run: node upgrade-videos.js
 * Progress saved every 3 posts — safe to stop and resume.
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

// ─── Config ─────────────────────────────────────────────────────────────────
const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const CHROME_PROFILE   = process.env.CHROME_PROFILE || 'Default';
const OUTPUT_JSON = './output/saved_posts.json';
const MEDIA_DIR   = './output/media';

const delay = (min, max) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ─── ffmpeg ──────────────────────────────────────────────────────────────────
function findFfmpeg() {
  // Dynamically search WinGet Packages for any Gyan.FFmpeg installation
  const wingetPkgs = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages`;
  const extraCandidates = [];
  try {
    const pkgEntries = readdirSync(wingetPkgs);
    const ffmpegPkg = pkgEntries.find(e => e.startsWith('Gyan.FFmpeg'));
    if (ffmpegPkg) {
      const pkgDir = join(wingetPkgs, ffmpegPkg);
      const subDirs = readdirSync(pkgDir);
      for (const sub of subDirs) {
        extraCandidates.push(join(pkgDir, sub, 'bin', 'ffmpeg.exe'));
      }
    }
  } catch {}

  const candidates = [
    'ffmpeg',
    `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`,
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    ...extraCandidates,
  ];
  for (const c of candidates) {
    try { execSync(`"${c}" -version`, { stdio: 'pipe' }); return c; }
    catch {}
  }
  return null;
}

function ffmpegHLS(m3u8Url, dest, ffmpegBin) {
  const r = spawnSync(ffmpegBin, [
    '-y', '-i', m3u8Url,
    '-c', 'copy', '-movflags', '+faststart',
    dest,
  ], { stdio: 'pipe', timeout: 300_000 });
  return r.status === 0;
}

// ─── Direct download ─────────────────────────────────────────────────────────
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
        const ws = createWriteStream(tmp);
        res.pipe(ws);
        ws.on('finish', () => {
          try { if (existsSync(dest)) unlinkSync(dest); }
          catch {}
          try { renameSync(tmp, dest); resolve(true); }
          catch { resolve(false); }
        });
        ws.on('error', () => resolve(false));
        res.on('error', () => resolve(false));
      }).on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

// ─── Chrome profile copy ─────────────────────────────────────────────────────
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
  const tempRoot = join(os.tmpdir(), `pw-vid-${Date.now()}`);
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

// ─── Video URL extraction ────────────────────────────────────────────────────
/** Try every trick to get a streamable video URL from the current page */
async function extractVideoUrl(page) {
  // 1. Check <video> src / currentSrc directly
  const domSrc = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return v.currentSrc || v.src || null;
  }).catch(() => null);
  if (domSrc && domSrc.startsWith('http')) return domSrc;

  // 2. Check <source> elements inside <video>
  const sourceSrc = await page.evaluate(() => {
    const sources = Array.from(document.querySelectorAll('video source'));
    for (const s of sources) {
      const src = s.getAttribute('src');
      if (src && src.startsWith('http')) return src;
    }
    return null;
  }).catch(() => null);
  if (sourceSrc) return sourceSrc;

  // 3. Scan all inline <script> tags for .m3u8 or licdn.com/dms/playback URLs
  const scriptUrl = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const s of scripts) {
      const text = s.textContent || '';
      const m = text.match(/https?:\/\/[^"'\s]*(?:\.m3u8|dms\/playback)[^"'\s]*/);
      if (m) return m[0];
    }
    return null;
  }).catch(() => null);
  if (scriptUrl) return scriptUrl;

  // 4. Check data attributes on video container elements
  const dataUrl = await page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[data-sources], [data-config-url], [data-video-url], [data-media-url]'
    );
    for (const el of candidates) {
      for (const attr of el.attributes) {
        if (attr.value && attr.value.includes('licdn.com')) return attr.value;
      }
    }
    return null;
  }).catch(() => null);
  if (dataUrl) return dataUrl;

  return null;
}

// ─── Play triggers ───────────────────────────────────────────────────────────
async function triggerPlay(page) {
  await page.evaluate(() => {
    // Scroll first visible video into viewport
    const videoEl = document.querySelector(
      'video, .video-s-container, [data-embed-type="VIDEO"], .feed-shared-update-v2__media'
    );
    if (videoEl) videoEl.scrollIntoView({ behavior: 'instant', block: 'center' });
  }).catch(() => {});

  await delay(800, 1200);

  await page.evaluate(() => {
    // Try every known LinkedIn play button selector
    const selectors = [
      'button[aria-label*="Play" i]',
      'button[data-control-name*="play" i]',
      '.video-s-container button',
      '.vjs-play-control',
      '[data-test-play-button]',
      'button[data-urn*="video" i]',
      '.video-play-button',
      '.feed-shared-linkedin-video__transcription-toggle',
      '.linkedin-video-player button',
      'button.player-controls-play-btn',
      '.artdeco-hoverable-trigger button',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return; }
    }
    // Last resort: play() on any <video> element
    document.querySelectorAll('video').forEach(v => {
      try { v.muted = true; v.play().catch(() => {}); } catch {}
    });
  }).catch(() => {});
}

// ─── Per-post upgrade ────────────────────────────────────────────────────────
async function downloadVideoForPost(page, post, ffmpegBin) {
  if (!post.url) return false;

  let capturedUrl = null;

  // Intercept network requests for video manifests
  const onRequest = req => {
    const url = req.url();
    if (capturedUrl) return; // already have one
    if (
      url.includes('.m3u8') ||
      url.includes('dms/playback') ||
      url.includes('/ambry/') ||
      (url.includes('licdn.com') && url.includes('.mp4') && !url.includes('company'))
    ) {
      capturedUrl = url;
    }
  };
  page.on('request', onRequest);

  try {
    // Navigate with networkidle for more complete page load
    await page.goto(post.url, { waitUntil: 'networkidle', timeout: 45_000 });
    await delay(1500, 2500);

    // Check DOM immediately (sometimes src is already set)
    capturedUrl = capturedUrl || await extractVideoUrl(page);

    if (!capturedUrl) {
      // Trigger play and wait up to 12 seconds for a video request
      await triggerPlay(page);

      // Wait for capture with polling
      for (let i = 0; i < 24 && !capturedUrl; i++) {
        await delay(500, 500);
        capturedUrl = capturedUrl || await extractVideoUrl(page);
      }
    }

    if (!capturedUrl) {
      // Second attempt: reload and try again
      await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
      await delay(2000, 3000);
      await triggerPlay(page);
      for (let i = 0; i < 20 && !capturedUrl; i++) {
        await delay(500, 500);
        capturedUrl = capturedUrl || await extractVideoUrl(page);
      }
    }

    if (!capturedUrl) return false;

    const prefix = `post_${String(post.index).padStart(4, '0')}`;
    const dest = join(MEDIA_DIR, `${prefix}_vid_0.mp4`);

    let ok = false;
    if (capturedUrl.includes('.m3u8') || capturedUrl.includes('dms/playback')) {
      process.stdout.write(' [HLS→MP4]');
      ok = ffmpegHLS(capturedUrl, dest, ffmpegBin);
    } else {
      process.stdout.write(' [MP4 download]');
      ok = await downloadToFile(capturedUrl, dest);
    }

    if (ok) {
      post.mediaFiles = post.mediaFiles || [];
      post.mediaFiles.push({
        type: 'video',
        file: `${prefix}_vid_0.mp4`,
        originalUrl: capturedUrl,
      });
      return true;
    }
    return false;

  } catch {
    return false;
  } finally {
    page.off('request', onRequest);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  if (!existsSync(OUTPUT_JSON)) {
    console.error('[!] Run the scraper first (saved_posts.json not found).');
    process.exit(1);
  }
  mkdirSync(MEDIA_DIR, { recursive: true });

  const ffmpegBin = findFfmpeg();
  if (!ffmpegBin) {
    console.error('[!] ffmpeg not found. Install with: winget install --id Gyan.FFmpeg -e');
    process.exit(1);
  }
  console.log(`[+] ffmpeg: ${ffmpegBin}`);

  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));

  const toUpgrade = posts.filter(p => {
    if (!p.url) return false;
    const mf = p.mediaFiles || [];
    const hasVidThumb = mf.some(m =>
      m.type === 'image' && m.originalUrl && (
        m.originalUrl.includes('videocover') ||
        m.originalUrl.includes('feedshare-thumbnail')
      )
    );
    const alreadyHasVideo = mf.some(m => m.type === 'video');
    return hasVidThumb && !alreadyHasVideo;
  });

  console.log(`[*] ${toUpgrade.length} video posts to process.\n`);
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

  // Login check
  await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await delay(2000, 3000);
  if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
    console.log('[!] Please log in in the browser (up to 2 min)...');
    await page.waitForURL(u => !u.includes('/login') && !u.includes('/checkpoint'),
      { timeout: 120_000 });
    console.log('[+] Logged in.');
  }

  let done = 0, downloaded = 0, failed = 0;

  for (const post of toUpgrade) {
    process.stdout.write(`\r  [${done + 1}/${toUpgrade.length}] #${post.index}...          `);

    const ok = await downloadVideoForPost(page, post, ffmpegBin);
    if (ok) {
      downloaded++;
      process.stdout.write(` ✓`);
    } else {
      failed++;
    }

    done++;
    if (done % 3 === 0) {
      writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
    }

    await delay(2000, 4000);
  }

  writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2));
  await context.close();

  console.log(`\n\n[done] ${downloaded} videos downloaded, ${failed} failed/no video found.`);
  console.log('[*] Restart the viewer: npm run viewer');
}

run().catch(e => { console.error('\n[error]', e.message); process.exit(1); });
