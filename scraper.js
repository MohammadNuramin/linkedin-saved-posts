import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'fs';
import { createWriteStream } from 'fs';
import { join, extname } from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import os from 'os';
import { execSync } from 'child_process';
import 'dotenv/config';
import { enrichPostsWithPostedAt } from './post-time.js';

// ─── Config ────────────────────────────────────────────────────────────────
const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const CHROME_PROFILE   = process.env.CHROME_PROFILE || 'Default';
const EMAIL    = process.env.LINKEDIN_EMAIL;
const PASSWORD = process.env.LINKEDIN_PASSWORD;
const OUTPUT_DIR  = './output';
const MEDIA_DIR   = join(OUTPUT_DIR, 'media');
const MD_DIR      = join(OUTPUT_DIR, 'posts');
const OUTPUT_JSON = join(OUTPUT_DIR, 'saved_posts.json');
const MAX_POSTS   = parseInt(process.env.MAX_POSTS ?? '0'); // 0 = all
const MAX_AGE_MS  = 365 * 24 * 60 * 60 * 1000; // 1 year in ms

// Parse LinkedIn relative timestamps like "2mo", "3w", "1yr", "5d", "4h"
// Returns age in ms, or null if unparseable
function parseLinkedInAge(ts) {
  if (!ts) return null;
  const s = ts.toLowerCase().trim();
  // Match patterns: "2 months ago", "3w", "1yr", "5 days ago", etc.
  const map = [
    [/(\d+)\s*(yr?|year)s?/,   n => n * 365 * 24 * 3600 * 1000],
    [/(\d+)\s*(mo|month)s?/,   n => n * 30  * 24 * 3600 * 1000],
    [/(\d+)\s*(w|week)s?/,     n => n * 7   * 24 * 3600 * 1000],
    [/(\d+)\s*(d|day)s?/,      n => n * 1   * 24 * 3600 * 1000],
    [/(\d+)\s*(h|hour)s?/,     n => n * 3600 * 1000],
    [/(\d+)\s*(m|min)s?/,      n => n * 60 * 1000],
  ];
  for (const [re, calc] of map) {
    const m = s.match(re);
    if (m) return calc(parseInt(m[1]));
  }
  return null;
}

function isTooOld(timestamp) {
  const age = parseLinkedInAge(timestamp);
  if (age === null) return false; // unknown — keep it
  return age > MAX_AGE_MS;
}

// Human-like random delay between min and max ms
const delay = (min, max) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ─── Chrome profile copy (so Chrome can stay open) ─────────────────────────
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
  catch { /* ignore */ }
}

function copyProfile() {
  const src = join(CHROME_USER_DATA, CHROME_PROFILE);
  const tempRoot = join(os.tmpdir(), `pw-li-${Date.now()}`);
  const tempProf = join(tempRoot, CHROME_PROFILE);
  mkdirSync(tempProf, { recursive: true });

  console.log('[*] Copying Chrome profile (Chrome can stay open)...');

  function copyDir(s, d) {
    mkdirSync(d, { recursive: true });
    let entries;
    try { entries = readdirSync(s); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.includes(e) || SKIP_FILES.includes(e)) continue;
      const sp = join(s, e), dp = join(d, e);
      try {
        if (statSync(sp).isDirectory()) copyDir(sp, dp);
        else try { copyFileSync(sp, dp); } catch { /* locked — handled below */ }
      } catch { /* skip */ }
    }
  }
  copyDir(src, tempProf);

  // Re-copy critical locked files via PowerShell with shared read
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

// ─── Helpers ───────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [OUTPUT_DIR, MEDIA_DIR, MD_DIR])
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function safe(name) {
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

// ─── Login fallback ────────────────────────────────────────────────────────
async function loginIfNeeded(page) {
  if (!page.url().includes('/login') && !page.url().includes('/signin')) return;

  console.log('[*] Not logged in — attempting login...');
  if (!EMAIL || !PASSWORD) {
    console.log('[!] No credentials in .env. Please log in manually in the browser.');
    console.log('[!] Waiting up to 3 minutes...');
    await page.waitForURL('**/my-items/saved-posts/**', { timeout: 180_000 });
    return;
  }

  try {
    await page.fill('input[name="session_key"], input#username', EMAIL);
    await delay(500, 1200);
    await page.fill('input[name="session_password"], input#password', PASSWORD);
    await delay(400, 900);
    await page.click('button[type="submit"], button[data-litms-control-urn="login-submit"]');
    await page.waitForFunction(() => !location.href.includes('/login'), { timeout: 30_000 });
    if (page.url().includes('/checkpoint')) {
      console.log('[!] Verification required — please complete it in the browser (2 min).');
      await page.waitForFunction(() => !location.href.includes('/checkpoint'), { timeout: 120_000 });
    }
    console.log('[+] Logged in.');
    await page.goto('https://www.linkedin.com/my-items/saved-posts/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (e) {
    console.warn('[warn] Login issue:', e.message);
  }
}

// ─── Extract one post element ───────────────────────────────────────────────
// Selectors from: https://github.com/vampirepapi/link2notion
async function extractPost(el, index) {
  const post = { index, author: null, authorUrl: null, authorImage: null,
                 text: null, url: null, timestamp: null,
                 images: [], videos: [], mediaFiles: [] };
  try {
    // Author name — try multiple selectors
    for (const sel of [
      "span[dir='ltr'] span[aria-hidden='true']",
      ".entity-result__title-text a span[aria-hidden='true']",
      "a[href*='/in/'] span[aria-hidden='true']",
    ]) {
      const t = await el.$eval(sel, e => e.innerText.trim()).catch(() => null);
      if (t) { post.author = t; break; }
    }

    // Author URL
    const aEl = await el.$("a[href*='/in/']");
    if (aEl) {
      const href = await aEl.getAttribute('href');
      post.authorUrl = href?.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    }

    // Author profile image
    for (const sel of [
      'img.presence-entity__image',
      'img.EntityPhoto-circle-4',
      '.entity-result__universal-image img',
      "img[class*='presence']",
    ]) {
      const src = await el.$eval(sel, e => e.getAttribute('src')).catch(() => null);
      if (src && !src.startsWith('data:')) { post.authorImage = src; break; }
    }

    // Post text
    for (const sel of [
      'p.entity-result__content-summary',
      '.entity-result__content-summary',
      '.entity-result__summary',
    ]) {
      const t = await el.$eval(sel, e => e.innerText.trim()).catch(() => null);
      if (t && t.length > 5) {
        post.text = t.replace(/…see more\s*$/i, '').replace(/\.\.\.see more\s*$/i, '').trim();
        break;
      }
    }

    // Post URL
    const linkEl = await el.$("a[href*='/feed/update/']");
    if (linkEl) {
      const href = await linkEl.getAttribute('href');
      post.url = href?.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href?.split('?')[0]}`;
    }

    // Timestamp
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
      // LinkedIn sometimes puts HLS url in data-video-url or similar attrs
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

  } catch (e) {
    console.warn(`\n  [warn] post ${index}: ${e.message}`);
  }
  return post;
}

// ─── Write markdown file ───────────────────────────────────────────────────
function writeMarkdown(post) {
  const title = (post.text || post.author || 'LinkedIn Post').split('\n')[0].slice(0, 80);
  const filename = `${String(post.index).padStart(3, '0')}-${safe(title)}.md`;
  const mediaLines = post.mediaFiles.map(m =>
    m.type === 'image' ? `![image](../media/${m.file})` : `[video](../media/${m.file})`
  ).join('\n');
  const postedLabel = post.postedAt || 'Unknown';

  const md = `# ${title}

**Author:** [${post.author || 'Unknown'}](${post.authorUrl || ''})
**Posted:** ${postedLabel}
**Saved View Label:** ${post.timestamp || 'Unknown'}
**Post:** ${post.url || ''}

---

${post.text || '*No text content*'}

${mediaLines}
`.trimEnd() + '\n';

  writeFileSync(join(MD_DIR, filename), md, 'utf8');
  return filename;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  ensureDirs();

  const tempRoot = copyProfile();

  console.log('[*] Launching Chrome with your existing session...');
  const context = await chromium.launchPersistentContext(tempRoot, {
    channel: 'chrome',
    args: [`--profile-directory=${CHROME_PROFILE}`],
    headless: false,
    slowMo: 50,
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Capture video URLs from network requests (LinkedIn loads HLS manifests separately)
  const capturedVideoUrls = new Map(); // postUrn -> [videoUrl]
  page.on('request', req => {
    const url = req.url();
    if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('dms/playback') || url.includes('dms/video')) {
      // LinkedIn video CDN — associate with most recent post being processed
      if (!capturedVideoUrls.has('_latest')) capturedVideoUrls.set('_latest', []);
      capturedVideoUrls.get('_latest').push(url.split('?')[0]);
    }
  });

  try {
    console.log('[*] Opening LinkedIn saved posts...');
    await page.goto('https://www.linkedin.com/my-items/saved-posts/', {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    await delay(2000, 3500);

    await loginIfNeeded(page);

    // Wait for post containers using the correct selector from link2notion
    console.log('[*] Waiting for posts to load...');
    await page.waitForSelector(
      "div[data-chameleon-result-urn], .entity-result, li.reusable-search__result-container",
      { timeout: 30_000 }
    ).catch(() => {});
    await delay(2500, 4000);

    const posts = [];
    let noNew = 0;
    let scrolls = 0;
    const MAX_SCROLLS = 200;

    console.log('[*] Scrolling and scraping...\n');

    while (scrolls < MAX_SCROLLS && noNew < 8) {
      // Count using the primary selector from link2notion repo
      const count = await page.evaluate(() =>
        document.querySelectorAll('div[data-chameleon-result-urn]').length
      );

      if (count > posts.length) {
        const allEls = await page.$$('div[data-chameleon-result-urn]');
        let hitAgeLimit = false;
        for (let i = posts.length; i < allEls.length; i++) {
          if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) break;
          process.stdout.write(`\r  Scraped: ${posts.length + 1} posts`);
          const post = await extractPost(allEls[i], posts.length + 1);
          if (isTooOld(post.timestamp)) {
            console.log(`\n[*] Post ${posts.length + 1} is older than 1 year ("${post.timestamp}") — stopping.`);
            hitAgeLimit = true;
            break;
          }
          posts.push(post);
        }
        if (hitAgeLimit) break;
        noNew = 0;
      } else {
        noNew++;
      }

      if (MAX_POSTS > 0 && posts.length >= MAX_POSTS) {
        console.log(`\n[*] Reached MAX_POSTS limit (${MAX_POSTS}).`);
        break;
      }

      // Scroll — every 3rd scroll go all the way to the bottom to reliably trigger
      // LinkedIn's infinite-scroll loader; otherwise use a human-like partial scroll.
      await page.evaluate((goToBottom) => {
        if (goToBottom) {
          window.scrollTo(0, document.body.scrollHeight);
        } else {
          const amount = window.innerHeight * (0.7 + Math.random() * 0.6);
          window.scrollBy(0, amount);
        }
      }, scrolls % 3 === 0);

      // Random pause 2.5-5s between scrolls (human-like)
      await delay(2500, 5000);
      scrolls++;

      if (scrolls % 10 === 0) {
        console.log(`\n  [pause] ${scrolls} scrolls done, ${posts.length} posts — taking a short break...`);
        await delay(4000, 7000); // extra break every 10 scrolls
      }
    }

    if (posts.length === 0) {
      console.log('\n[!] No posts found. Check output/debug_page.png to see what loaded.');
      await page.screenshot({ path: join(OUTPUT_DIR, 'debug_page.png') });
      return;
    }

    console.log(`\n\n[+] Scraped ${posts.length} posts. Downloading media...`);

    // Download media
    for (const post of posts) {
      const prefix = `post_${String(post.index).padStart(4, '0')}`;
      for (let i = 0; i < post.images.length; i++) {
        const f = await downloadFile(post.images[i], MEDIA_DIR, `${prefix}_img_${i}`);
        if (f) post.mediaFiles.push({ type: 'image', file: f, originalUrl: post.images[i] });
      }
      for (let i = 0; i < post.videos.length; i++) {
        const f = await downloadFile(post.videos[i], MEDIA_DIR, `${prefix}_vid_${i}`);
        if (f) post.mediaFiles.push({ type: 'video', file: f, originalUrl: post.videos[i] });
      }
      process.stdout.write(`\r  Media: ${post.index}/${posts.length}`);
    }

    console.log('\n[*] Resolving original publish times...');
    await enrichPostsWithPostedAt(posts, {
      concurrency: 8,
      onProgress: ({ processed, total, updated }) => {
        process.stdout.write(`\r  Posted times: ${processed}/${total} checked, ${updated} found`);
      },
    });

    // Write markdown files
    console.log('\n[*] Writing markdown files...');
    for (const post of posts) writeMarkdown(post);

    // Write JSON
    writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2), 'utf8');

    console.log(`\n[done] ${posts.length} posts saved to:`);
    console.log(`  JSON   → ${OUTPUT_JSON}`);
    console.log(`  Posts  → ${MD_DIR}/`);
    console.log(`  Media  → ${MEDIA_DIR}/`);

  } finally {
    await context.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
