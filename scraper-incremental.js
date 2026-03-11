/**
 * LinkedIn Saved Posts — Incremental Sync
 * Runs daily via Windows Task Scheduler.
 * Only fetches posts not yet in saved_posts.json.
 * Stops as soon as it encounters a previously seen post.
 */

import { chromium } from 'playwright';
import {
  writeFileSync, readFileSync, mkdirSync, existsSync,
  copyFileSync, readdirSync, statSync, rmSync, unlinkSync,
} from 'fs';
import { createWriteStream } from 'fs';
import { join, extname } from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import os from 'os';
import { execSync } from 'child_process';
import 'dotenv/config';

// ─── Config ────────────────────────────────────────────────────────────────
const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const CHROME_PROFILE   = process.env.CHROME_PROFILE || 'Default';
const EMAIL    = process.env.LINKEDIN_EMAIL;
const PASSWORD = process.env.LINKEDIN_PASSWORD;
const OUTPUT_DIR  = './output';
const MEDIA_DIR   = join(OUTPUT_DIR, 'media');
const MD_DIR      = join(OUTPUT_DIR, 'posts');
const OUTPUT_JSON = join(OUTPUT_DIR, 'saved_posts.json');
const SYNC_LOG    = join(OUTPUT_DIR, 'sync-log.json');
const MAX_AGE_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year

// Scheduled task runs headless — no browser window
const HEADLESS = process.env.HEADLESS !== 'false';

const delay = (min, max) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

/** Navigate with retry + exponential backoff (handles ERR_CONNECTION_RESET) */
async function gotoWithRetry(page, url, opts = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, opts);
      return;
    } catch (e) {
      const isRetryable = e.message.includes('ERR_CONNECTION_RESET') ||
        e.message.includes('ERR_CONNECTION_REFUSED') ||
        e.message.includes('ERR_CONNECTION_TIMED_OUT') ||
        e.message.includes('ERR_NETWORK_CHANGED') ||
        e.message.includes('Timeout');
      if (!isRetryable || attempt === maxRetries) throw e;
      const wait = attempt * 15_000 + Math.random() * 5_000;
      console.warn(`[sync] Navigation failed (${e.message.split('\n')[0]}). Retry ${attempt}/${maxRetries} in ${Math.round(wait / 1000)}s...`);
      await delay(wait, wait + 1000);
    }
  }
}

// ─── Sync log ──────────────────────────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(readFileSync(SYNC_LOG, 'utf8')); } catch { return []; }
}

function appendLog(entry) {
  const log = loadLog();
  log.unshift({ ...entry, date: new Date().toISOString() });
  writeFileSync(SYNC_LOG, JSON.stringify(log.slice(0, 100), null, 2), 'utf8');
}

// ─── Existing posts ────────────────────────────────────────────────────────
function loadExistingPosts() {
  try {
    const data = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// ─── Timestamp parsing ─────────────────────────────────────────────────────
function parseTimestampAge(ts) {
  if (!ts) return Infinity;
  const s = ts.toLowerCase().trim();
  const map = [
    [/(\d+)\s*(yr?|year)s?/, n => n * 365 * 24 * 3600 * 1000],
    [/(\d+)\s*(mo|month)s?/, n => n * 30  * 24 * 3600 * 1000],
    [/(\d+)\s*(w|week)s?/,   n => n * 7   * 24 * 3600 * 1000],
    [/(\d+)\s*(d|day)s?/,    n => n * 1   * 24 * 3600 * 1000],
    [/(\d+)\s*(h|hour)s?/,   n => n * 3600 * 1000],
    [/(\d+)\s*(m|min)s?/,    n => n * 60 * 1000],
  ];
  for (const [re, calc] of map) {
    const m = s.match(re);
    if (m) return calc(parseInt(m[1], 10));
  }
  return Infinity;
}

// ─── Profile copy ─────────────────────────────────────────────────────────
const SKIP_DIRS  = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache'];
const SKIP_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function copyLockedFile(src, dest) {
  const ps = `$s='${src.replace(/\\/g,'\\\\').replace(/'/g,"''")}';$d='${dest.replace(/\\/g,'\\\\').replace(/'/g,"''")}';New-Item -ItemType Directory -Path (Split-Path $d) -Force|Out-Null;try{$fs=[System.IO.File]::Open($s,'Open','Read','ReadWrite');$fd=[System.IO.File]::Create($d);$fs.CopyTo($fd);$fs.Close();$fd.Close();}catch{}`;
  try { execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: 'pipe' }); } catch { /* skip */ }
}

function copyProfile() {
  const src = join(CHROME_USER_DATA, CHROME_PROFILE);
  const tempRoot = join(os.tmpdir(), `pw-li-inc-${Date.now()}`);
  const tempProf = join(tempRoot, CHROME_PROFILE);
  mkdirSync(tempProf, { recursive: true });

  function copyDir(s, d) {
    mkdirSync(d, { recursive: true });
    let entries;
    try { entries = readdirSync(s); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.includes(e) || SKIP_FILES.includes(e)) continue;
      const sp = join(s, e), dp = join(d, e);
      try {
        if (statSync(sp).isDirectory()) copyDir(sp, dp);
        else try { copyFileSync(sp, dp); } catch { /* locked */ }
      } catch { /* skip */ }
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
  return tempRoot;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [OUTPUT_DIR, MEDIA_DIR, MD_DIR])
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function sanitize(name) {
  return (name || 'untitled').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '-').slice(0, 80) || 'untitled';
}

const CT_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};

async function downloadFile(url, destDir, hint) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.destroy();
          downloadFile(res.headers.location, destDir, hint).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); resolve(null); return; }
        // Use Content-Type for extension — LinkedIn URLs have no extension in path
        const ct = (res.headers['content-type'] || '').split(';')[0].trim();
        const ext = CT_EXT[ct] || extname(parsed.pathname).split('?')[0] || '.jpg';
        const fname = hint.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 100) + ext;
        const dest = join(destDir, fname);
        if (existsSync(dest)) { res.destroy(); resolve(fname); return; }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(fname); });
        file.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

// ─── Login ────────────────────────────────────────────────────────────────
async function loginIfNeeded(page) {
  const url = page.url();
  const isLoginPage = url.includes('/login') || url.includes('/signin') || url.includes('/authwall');

  if (!isLoginPage) {
    // Even without a redirect, verify saved-posts content is actually visible
    const hasPosts = await page.$('div[data-chameleon-result-urn]').catch(() => null);
    if (hasPosts) return true;
    await delay(2500, 3500);
    const hasPostsRetry = await page.$('div[data-chameleon-result-urn]').catch(() => null);
    if (hasPostsRetry) return true;
    console.warn('[sync] Saved posts not visible — session may have expired.');
  }

  // Try credential login if available
  if (EMAIL && PASSWORD) {
    try {
      if (!page.url().includes('/login') && !page.url().includes('/signin')) {
        await gotoWithRetry(page, 'https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await delay(1000, 1500);
      }
      await page.fill('input[name="session_key"], input#username', EMAIL);
      await delay(500, 900);
      await page.fill('input[name="session_password"], input#password', PASSWORD);
      await delay(400, 800);
      await page.click('button[type="submit"], button[data-litms-control-urn="login-submit"]');
      await page.waitForFunction(() => !location.href.includes('/login'), { timeout: 30_000 });
      if (page.url().includes('/checkpoint')) {
        console.error('[error] 2FA required — aborting.');
        return false;
      }
      await gotoWithRetry(page, 'https://www.linkedin.com/my-items/saved-posts/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await delay(2000, 3000);
      return true;
    } catch (e) {
      console.error('[error] Credential login failed:', e.message);
    }
  }

  // No credentials — if running visibly, wait for manual login
  if (!HEADLESS) {
    console.log('[sync] Not logged in. Please log in in the browser window (up to 2 min)...');
    try {
      await page.waitForSelector('div[data-chameleon-result-urn]', { timeout: 120_000 });
      console.log('[sync] Logged in — continuing.');
      return true;
    } catch {
      console.error('[error] Timed out waiting for manual login.');
      return false;
    }
  }

  console.error('[error] Session expired. Run "npm run sync:visible" to log in manually.');
  return false;
}

// ─── Extract post ─────────────────────────────────────────────────────────
async function extractPost(el, index) {
  const post = { index, author: null, authorUrl: null, authorImage: null,
                 text: null, url: null, timestamp: null,
                 images: [], videos: [], mediaFiles: [] };
  try {
    for (const sel of ["span[dir='ltr'] span[aria-hidden='true']", ".entity-result__title-text a span[aria-hidden='true']", "a[href*='/in/'] span[aria-hidden='true']"]) {
      const t = await el.$eval(sel, e => e.innerText.trim()).catch(() => null);
      if (t) { post.author = t; break; }
    }
    const aEl = await el.$("a[href*='/in/']");
    if (aEl) {
      const href = await aEl.getAttribute('href');
      post.authorUrl = href?.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    }
    for (const sel of ['img.presence-entity__image', 'img.EntityPhoto-circle-4', '.entity-result__universal-image img']) {
      const src = await el.$eval(sel, e => e.getAttribute('src')).catch(() => null);
      if (src && !src.startsWith('data:')) { post.authorImage = src; break; }
    }
    for (const sel of ['p.entity-result__content-summary', '.entity-result__content-summary', '.entity-result__summary']) {
      const t = await el.$eval(sel, e => e.innerText.trim()).catch(() => null);
      if (t && t.length > 5) {
        post.text = t.replace(/…see more\s*$/i, '').replace(/\.\.\.see more\s*$/i, '').trim();
        break;
      }
    }
    const linkEl = await el.$("a[href*='/feed/update/']");
    if (linkEl) {
      const href = await linkEl.getAttribute('href');
      post.url = href?.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href?.split('?')[0]}`;
    }
    for (const sel of ['p.t-black--light.t-12', '.t-12.t-black--light', 'time']) {
      const t = await el.$eval(sel, e => (e.getAttribute('datetime') || e.innerText || '').trim()).catch(() => null);
      if (t) { post.timestamp = t.split('\n')[0].replace(/[•·].*$/, '').trim(); break; }
    }
    // Post images — run inside browser to access srcset for highest quality
    const imgAndVideoData = await el.evaluate(container => {
      const SKIP = ['profile-displayphoto', 'ghost', 'presence-entity__image',
                    'EntityPhoto', 'static.licdn.com', 'liicons', 'data:',
                    'company-logo_100', 'company-logo_200', 'company-logo_50',
                    'organizational-page-logo'];
      const images = [];

      container.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || img.getAttribute('data-delayed-url') || '';
        if (!src || SKIP.some(s => src.includes(s))) return;
        if (!src.includes('licdn.com') && !src.startsWith('http')) return;

        // Pick highest-width entry from srcset; fall back to src
        let bestUrl = src;
        let bestW = 0;
        const srcset = img.getAttribute('srcset') || '';
        if (srcset) {
          srcset.split(',').forEach(entry => {
            const parts = entry.trim().split(/\s+/);
            const url = parts[0];
            const w = parseInt(parts[1]) || 0;
            if (url && url.startsWith('http') && w > bestW) { bestW = w; bestUrl = url; }
          });
        }
        if (bestUrl && !images.includes(bestUrl)) images.push(bestUrl);
      });

      // Videos — read currentSrc (set by browser player) and all data attrs
      const srcs = [], posters = [];
      container.querySelectorAll('video').forEach(v => {
        if (v.currentSrc) srcs.push(v.currentSrc);
        if (v.src) srcs.push(v.src);
        v.querySelectorAll('source').forEach(s => { if (s.src) srcs.push(s.src); });
        if (v.poster && !v.poster.startsWith('data:') && !v.poster.includes('ghost'))
          posters.push(v.poster);
      });
      container.querySelectorAll('[data-sources]').forEach(el => {
        try {
          const sources = JSON.parse(el.getAttribute('data-sources'));
          if (Array.isArray(sources)) sources.forEach(s => {
            const u = s.src || s.url || s.baseUrl || s.streamingLocations?.[0]?.url;
            if (u) srcs.push(u);
          });
        } catch {}
      });
      container.querySelectorAll('[data-video-url],[data-hls-url],[data-dash-url]').forEach(el => {
        ['data-video-url','data-hls-url','data-dash-url'].forEach(attr => {
          const u = el.getAttribute(attr); if (u) srcs.push(u);
        });
      });

      return { images, srcs: [...new Set(srcs)], posters: [...new Set(posters)] };
    }).catch(() => ({ images: [], srcs: [], posters: [] }));

    imgAndVideoData.images.forEach(url => { if (!post.images.includes(url)) post.images.push(url); });
    imgAndVideoData.srcs.forEach(s => { if (s && s.startsWith('http')) post.videos.push(s); });
    imgAndVideoData.posters.forEach(s => { if (s && s.startsWith('http') && !post.images.includes(s)) post.images.push(s); });
    post.videos = [...new Set(post.videos.filter(Boolean))];

    // Carousel / document posts — click "Next" to capture all pages
    const hasDoc = post.images.some(u => u.includes('document'));
    if (hasDoc) {
      try {
        const nextSelectors = [
          'button[aria-label*="Next" i]',
          'button[aria-label*="next slide" i]',
          'button[aria-label*="forward" i]',
          '.carousel__next',
        ].join(', ');
        for (let page = 0; page < 50; page++) {
          const nextBtn = await el.$(nextSelectors);
          if (!nextBtn) break;
          const disabled = await nextBtn.evaluate(b =>
            b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled')
          );
          if (disabled) break;
          await nextBtn.click();
          await delay(600, 900);
          const pageImgs = await el.evaluate(c =>
            [...c.querySelectorAll('img')].map(i => i.src).filter(s => s && s.includes('licdn.com'))
          );
          pageImgs.forEach(s => { if (!post.images.includes(s)) post.images.push(s); });
        }
      } catch { /* carousel nav failed — keep what we have */ }
    }

  } catch { /* skip */ }
  return post;
}

// ─── Write markdown ───────────────────────────────────────────────────────
function writeMarkdown(post) {
  const title = (post.text || post.author || 'LinkedIn Post').split('\n')[0].slice(0, 80);
  const filename = `${String(post.index).padStart(3, '0')}-${sanitize(title)}.md`;
  const mediaLines = post.mediaFiles.map(m =>
    m.type === 'image' ? `![image](../media/${m.file})` : `[video](../media/${m.file})`
  ).join('\n');
  const md = `# ${title}\n\n**Author:** [${post.author || 'Unknown'}](${post.authorUrl || ''})\n**Date:** ${post.timestamp || 'Unknown'}\n**Post:** ${post.url || ''}\n\n---\n\n${post.text || '*No text content*'}\n\n${mediaLines}\n`.trimEnd() + '\n';
  writeFileSync(join(MD_DIR, filename), md, 'utf8');
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  console.log(`\n[sync] Starting incremental sync — ${new Date().toLocaleString()}`);

  ensureDirs();

  // Load existing posts and build known-URL index
  const existingPosts = loadExistingPosts();
  const knownUrls = new Set(existingPosts.map(p => p.url).filter(Boolean));
  console.log(`[sync] Existing posts: ${existingPosts.length} | Known URLs: ${knownUrls.size}`);

  const tempRoot = copyProfile();
  console.log('[sync] Profile copied. Launching browser...');

  const context = await chromium.launchPersistentContext(tempRoot, {
    channel: 'chrome',
    args: [`--profile-directory=${CHROME_PROFILE}`],
    headless: HEADLESS,
    slowMo: 60,
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  let newPosts = [];

  try {
    await gotoWithRetry(page, 'https://www.linkedin.com/my-items/saved-posts/', {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    await delay(2000, 3000);

    const ok = await loginIfNeeded(page);
    if (!ok) {
      appendLog({ status: 'error', reason: 'login_required', newPosts: 0, totalPosts: existingPosts.length });
      return;
    }

    await page.waitForSelector('div[data-chameleon-result-urn], .entity-result', { timeout: 30_000 }).catch(() => {});
    await delay(2000, 3500);

    let noNew = 0, scrolls = 0;
    let hitKnown = false, hitAgeLimit = false;
    const seen = new Set(); // avoid double-counting within this run

    console.log('[sync] Scrolling...');

    while (scrolls < 200 && noNew < 8 && !hitKnown && !hitAgeLimit) {
      const count = await page.evaluate(() =>
        document.querySelectorAll('div[data-chameleon-result-urn]').length
      );

      const totalSeen = newPosts.length + (count - newPosts.length);

      if (count > newPosts.length) {
        const allEls = await page.$$('div[data-chameleon-result-urn]');

        for (let i = newPosts.length; i < allEls.length; i++) {
          const post = await extractPost(allEls[i], existingPosts.length + newPosts.length + i + 1);

          // Stop if we've hit a 1-year-old post
          if (parseTimestampAge(post.timestamp) > MAX_AGE_MS) {
            console.log(`[sync] Hit age limit at post ${i + 1} ("${post.timestamp}") — stopping.`);
            hitAgeLimit = true;
            break;
          }

          // Stop if we've seen this URL before (already saved)
          if (post.url && knownUrls.has(post.url)) {
            console.log(`[sync] Hit known post at position ${i + 1} — no more new content.`);
            hitKnown = true;
            break;
          }

          // Skip if we already encountered this URL in this run
          if (post.url && seen.has(post.url)) continue;
          if (post.url) seen.add(post.url);

          newPosts.push(post);
          process.stdout.write(`\r  New posts found: ${newPosts.length}`);
        }

        noNew = 0;
      } else {
        noNew++;
      }

      if (hitKnown || hitAgeLimit) break;

      await page.evaluate((goToBottom) => {
        if (goToBottom) { window.scrollTo(0, document.body.scrollHeight); }
        else { const amount = window.innerHeight * (0.7 + Math.random() * 0.6); window.scrollBy(0, amount); }
      }, scrolls % 3 === 0);
      await delay(2500, 5000);
      scrolls++;
    }

    process.stdout.write('\n');
    console.log(`[sync] Found ${newPosts.length} new post(s).`);

    if (newPosts.length > 0) {
      // Download media for new posts
      console.log('[sync] Downloading media...');
      for (const post of newPosts) {
        // Use activity URN as stable prefix — index is mutable after re-indexing
        const actId = post.url?.match(/activity[:%3A]+(\d+)/)?.[1];
        const prefix = actId ? `act_${actId}` : `post_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        for (let i = 0; i < post.images.length; i++) {
          const f = await downloadFile(post.images[i], MEDIA_DIR, `${prefix}_img_${i}`);
          if (f) post.mediaFiles.push({ type: 'image', file: f, originalUrl: post.images[i] });
        }
        for (let i = 0; i < post.videos.length; i++) {
          const f = await downloadFile(post.videos[i], MEDIA_DIR, `${prefix}_vid_${i}`);
          if (f) post.mediaFiles.push({ type: 'video', file: f, originalUrl: post.videos[i] });
        }
      }

      // Re-index: new posts prepended, existing posts shifted
      const merged = [...newPosts, ...existingPosts].map((p, i) => ({ ...p, index: i + 1 }));

      // Save JSON
      writeFileSync(OUTPUT_JSON, JSON.stringify(merged, null, 2), 'utf8');

      // Write markdown for new posts only
      for (const post of newPosts) writeMarkdown(post);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[sync] Done. +${newPosts.length} new posts → total ${merged.length} (${elapsed}s)`);
      console.log('[sync] Run "npm run upgrade" to download full-res images for the new posts.');
      console.log('[sync] Run "npm run upgrade:videos" to download videos for the new posts.');
      appendLog({ status: 'success', newPosts: newPosts.length, totalPosts: merged.length, elapsed: parseFloat(elapsed) });
    } else {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[sync] No new posts found. Total unchanged: ${existingPosts.length} (${elapsed}s)`);
      appendLog({ status: 'success', newPosts: 0, totalPosts: existingPosts.length, elapsed: parseFloat(elapsed) });
    }

  } catch (e) {
    console.error('[sync] Fatal error:', e.message);
    appendLog({ status: 'error', reason: e.message, newPosts: newPosts.length, totalPosts: existingPosts.length });
  } finally {
    await context.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error('[fatal]', err);
  appendLog({ status: 'error', reason: err.message, newPosts: 0, totalPosts: 0 });
  process.exit(1);
});
