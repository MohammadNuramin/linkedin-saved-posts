import { chromium } from 'playwright';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  copyFileSync, readdirSync, statSync, rmSync, unlinkSync,
} from 'fs';
import { join } from 'path';
import os from 'os';
import { execSync } from 'child_process';
import 'dotenv/config';
import { enrichPostMedia, needsPostMediaEnrichment, resolveFfmpegBinary } from './post-page-media.js';

const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';
const OUTPUT_JSON = './output/saved_posts.json';
const MEDIA_DIR = './output/media';
const HEADLESS = !process.argv.includes('--visible');

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1] ?? '', 10) : Infinity;
  return {
    limit: Number.isFinite(limit) ? limit : Infinity,
  };
}

const SKIP_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache'];
const SKIP_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function copyLockedFile(src, dest) {
  const ps = `$s='${src.replace(/\\/g, '\\\\').replace(/'/g, "''")}';$d='${dest.replace(/\\/g, '\\\\').replace(/'/g, "''")}';New-Item -ItemType Directory -Path (Split-Path $d) -Force|Out-Null;try{$fs=[System.IO.File]::Open($s,'Open','Read','ReadWrite');$fd=[System.IO.File]::Create($d);$fs.CopyTo($fd);$fs.Close();$fd.Close();}catch{}`;
  try {
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: 'pipe' });
  } catch {}
}

function copyProfile() {
  const src = join(CHROME_USER_DATA, CHROME_PROFILE);
  const tempRoot = join(os.tmpdir(), `pw-li-media-${Date.now()}`);
  const tempProf = join(tempRoot, CHROME_PROFILE);
  mkdirSync(tempProf, { recursive: true });

  function copyDir(from, to) {
    mkdirSync(to, { recursive: true });
    let entries = [];
    try { entries = readdirSync(from); } catch { return; }

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry) || SKIP_FILES.includes(entry)) continue;
      const srcPath = join(from, entry);
      const destPath = join(to, entry);
      try {
        if (statSync(srcPath).isDirectory()) copyDir(srcPath, destPath);
        else try { copyFileSync(srcPath, destPath); } catch {}
      } catch {}
    }
  }

  copyDir(src, tempProf);

  const networkSrc = join(src, 'Network');
  if (existsSync(networkSrc)) {
    mkdirSync(join(tempProf, 'Network'), { recursive: true });
    for (const file of ['Cookies', 'Cookies-journal']) {
      copyLockedFile(join(networkSrc, file), join(tempProf, 'Network', file));
    }
  }

  for (const file of ['Web Data', 'Login Data']) {
    copyLockedFile(join(src, file), join(tempProf, file));
  }

  for (const file of SKIP_FILES) {
    try { unlinkSync(join(tempProf, file)); } catch {}
  }

  return tempRoot;
}

async function run() {
  if (!existsSync(OUTPUT_JSON)) {
    console.error('[media] saved_posts.json not found. Run the scraper first.');
    process.exit(1);
  }

  mkdirSync(MEDIA_DIR, { recursive: true });

  const { limit } = parseArgs(process.argv.slice(2));
  const posts = JSON.parse(readFileSync(OUTPUT_JSON, 'utf8'));
  const targets = posts.filter(needsPostMediaEnrichment).slice(0, limit);

  console.log(`[media] ${targets.length} post(s) need missing videos or PDF attachments.`);
  if (targets.length === 0) return;

  const ffmpegBin = resolveFfmpegBinary();
  if (!ffmpegBin) {
    console.log('[media] ffmpeg not found. HLS-only videos will be skipped.');
  }

  const save = () => writeFileSync(OUTPUT_JSON, JSON.stringify(posts, null, 2), 'utf8');
  const tempRoot = copyProfile();

  const context = await chromium.launchPersistentContext(tempRoot, {
    channel: 'chrome',
    args: [`--profile-directory=${CHROME_PROFILE}`],
    headless: HEADLESS,
    slowMo: 30,
    viewport: { width: 1440, height: 1200 },
  });

  const page = await context.newPage();

  let updated = 0;
  let videoCount = 0;
  let documentCount = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const post = targets[i];
      const result = await enrichPostMedia(page, post, MEDIA_DIR, { ffmpegBin });
      if (result.updated) {
        updated++;
        videoCount += result.added.filter((asset) => asset.type === 'video').length;
        documentCount += result.added.filter((asset) => asset.type === 'document').length;
      }

      const label = result.added.length > 0
        ? result.added.map((asset) => asset.type).join(', ')
        : 'no new assets';
      process.stdout.write(`\r[media] ${i + 1}/${targets.length} (${label})   `);

      if ((i + 1) % 5 === 0) save();
    }

    process.stdout.write('\n');
    save();
    console.log(`[media] Done. Updated ${updated} post(s): ${videoCount} video(s), ${documentCount} PDF(s).`);
  } finally {
    await context.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('[media] Fatal:', error.message);
  process.exit(1);
});
