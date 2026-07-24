import { createWriteStream, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';
import { spawnSync, execSync } from 'child_process';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://www.linkedin.com/',
};

const DOCUMENT_PREVIEW_RE = /document-cover-images|document-images/i;
const VIDEO_THUMBNAIL_RE = /videocover|feedshare-thumbnail|video-thumbnail/i;
const DOCUMENT_MANIFEST_RE = /feedshare-document-master-manifest/i;
const DOCUMENT_PDF_RE = /feedshare-document-pdf-analyzed|\.pdf(?:$|\?)/i;
const VIDEO_URL_RE = /(?:\.mp4(?:$|\?)|\.m3u8(?:$|\?)|dms\/playback|dms\/video|playlist\/vid)/i;

const VIDEO_PLAY_SELECTORS = [
  'button[aria-label*="Play" i]',
  'button[data-control-name*="play" i]',
  '.video-s-container button',
  '.vjs-play-control',
  '[data-test-play-button]',
  'button[data-urn*="video" i]',
  '.video-play-button',
  '.linkedin-video-player button',
  'button.player-controls-play-btn',
];

function uniqByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const url = typeof item === 'string' ? item : item.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sortVideoCandidates(a, b) {
  const aMp4 = (a.type || '').includes('mp4') || /\.mp4(?:$|\?)/i.test(a.url);
  const bMp4 = (b.type || '').includes('mp4') || /\.mp4(?:$|\?)/i.test(b.url);
  if (aMp4 !== bMp4) return aMp4 ? -1 : 1;

  const aBitrate = parseNumber(a.bitrate);
  const bBitrate = parseNumber(b.bitrate);
  if (aBitrate !== bBitrate) return bBitrate - aBitrate;

  const aArea = parseNumber(a.width) * parseNumber(a.height);
  const bArea = parseNumber(b.width) * parseNumber(b.height);
  return bArea - aArea;
}

function isHlsUrl(url) {
  return /\.m3u8(?:$|\?)/i.test(url) || /dms\/playback/i.test(url);
}

function request(url) {
  return new Promise((resolve, reject) => {
    try {
      const client = url.startsWith('https:') ? https : http;
      client
        .get(url, { headers: REQUEST_HEADERS }, (res) => resolve(res))
        .on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}

async function downloadUrlToFile(url, dest) {
  if (existsSync(dest)) return true;

  const tmp = `${dest}.tmp`;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const res = await request(url).catch(() => null);
    if (!res) return false;

    if (res.statusCode === 301 || res.statusCode === 302) {
      const nextUrl = res.headers.location;
      res.destroy();
      if (!nextUrl) return false;
      url = nextUrl;
      continue;
    }

    if (res.statusCode !== 200) {
      res.destroy();
      return false;
    }

    const ok = await new Promise((resolve) => {
      const ws = createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close();
        try {
          if (existsSync(dest)) unlinkSync(dest);
        } catch {}
        try {
          renameSync(tmp, dest);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      ws.on('error', () => resolve(false));
      res.on('error', () => resolve(false));
    });
    return ok;
  }

  return false;
}

function findFfmpeg() {
  const wingetPkgs = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages`;
  const extraCandidates = [];

  try {
    const pkgEntries = readdirSync(wingetPkgs);
    const ffmpegPkg = pkgEntries.find((entry) => entry.startsWith('Gyan.FFmpeg'));
    if (ffmpegPkg) {
      const pkgDir = join(wingetPkgs, ffmpegPkg);
      for (const sub of readdirSync(pkgDir)) {
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

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" -version`, { stdio: 'pipe' });
      return candidate;
    } catch {}
  }

  return null;
}

function ffmpegHlsToMp4(url, dest, ffmpegBin) {
  const result = spawnSync(
    ffmpegBin,
    ['-y', '-i', url, '-c', 'copy', '-movflags', '+faststart', dest],
    { stdio: 'pipe', timeout: 300_000 }
  );
  return result.status === 0;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getMediaPrefix(post) {
  const activityId = post.url?.match(/activity(?:[:%3A/-]+)(\d{10,})/i)?.[1];
  return activityId ? `act_${activityId}` : `post_${String(post.index).padStart(4, '0')}`;
}

function hasMediaFile(post, type) {
  return (post.mediaFiles || []).some((media) => media.type === type);
}

function hasMatchingImage(post, regex) {
  return [
    ...(post.images || []),
    ...((post.mediaFiles || [])
      .filter((media) => media.type === 'image')
      .map((media) => media.originalUrl)),
  ].some((url) => regex.test(url || ''));
}

export function needsPostMediaEnrichment(post) {
  if (!post?.url) return false;

  const needsDocument = !hasMediaFile(post, 'document') && hasMatchingImage(post, DOCUMENT_PREVIEW_RE);
  const needsVideo = !hasMediaFile(post, 'video') && hasMatchingImage(post, VIDEO_THUMBNAIL_RE);
  return needsDocument || needsVideo;
}

async function scanPostPage(page) {
  return page.evaluate((playSelectors) => {
    const candidates = [];
    const addVideo = (url, meta = {}) => {
      if (!url || !/^https?:/i.test(url)) return;
      candidates.push({
        url,
        type: meta.type || '',
        bitrate: meta.bitrate || meta['data-bitrate'] || 0,
        width: meta.width || 0,
        height: meta.height || 0,
      });
    };

    document.querySelectorAll('video').forEach((video) => {
      addVideo(video.currentSrc, { type: 'video/mp4' });
      addVideo(video.src, { type: 'video/mp4' });
      video.querySelectorAll('source').forEach((source) => {
        addVideo(source.src, {
          type: source.type || 'video/mp4',
          width: source.getAttribute('width'),
          height: source.getAttribute('height'),
        });
      });
    });

    document.querySelectorAll('[data-sources]').forEach((node) => {
      try {
        const sources = JSON.parse(node.getAttribute('data-sources') || '[]');
        if (!Array.isArray(sources)) return;
        sources.forEach((source) => {
          addVideo(
            source.src || source.url || source.baseUrl || source.streamingLocations?.[0]?.url,
            source
          );
        });
      } catch {}
    });

    document
      .querySelectorAll('[data-video-url],[data-hls-url],[data-dash-url],[data-media-url]')
      .forEach((node) => {
        ['data-video-url', 'data-hls-url', 'data-dash-url', 'data-media-url'].forEach((attr) => {
          addVideo(node.getAttribute(attr), { type: node.getAttribute('type') || '' });
        });
      });

    const documentFrames = Array.from(document.querySelectorAll('iframe'))
      .map((frame) => frame.getAttribute('src') || '')
      .filter((src) => src.includes('native-document.html'));

    const playButtonPresent = playSelectors.some((selector) => document.querySelector(selector));

    return {
      videoCandidates: candidates,
      documentFrames,
      playButtonPresent,
    };
  }, VIDEO_PLAY_SELECTORS);
}

async function triggerVideoPlayback(page) {
  await page.evaluate((playSelectors) => {
    const videoTarget = document.querySelector(
      'video, .video-s-container, [data-embed-type="VIDEO"], .feed-shared-update-v2__media'
    );
    if (videoTarget) {
      videoTarget.scrollIntoView({ behavior: 'instant', block: 'center' });
    }

    for (const selector of playSelectors) {
      const button = document.querySelector(selector);
      if (button) {
        button.click();
        return;
      }
    }

    document.querySelectorAll('video').forEach((video) => {
      try {
        video.muted = true;
        video.play().catch(() => {});
      } catch {}
    });
  }, VIDEO_PLAY_SELECTORS).catch(() => {});
}

async function inspectPostPage(page, url) {
  const documentManifestUrls = new Set();
  const documentPdfUrls = new Set();
  const videoRequestUrls = new Set();

  const onRequest = (request) => {
    const requestUrl = request.url();
    if (DOCUMENT_MANIFEST_RE.test(requestUrl)) {
      documentManifestUrls.add(requestUrl);
    }
    if (DOCUMENT_PDF_RE.test(requestUrl)) {
      documentPdfUrls.add(requestUrl);
    }
    if (VIDEO_URL_RE.test(requestUrl)) {
      videoRequestUrls.add(requestUrl);
    }
  };

  page.on('request', onRequest);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    let scan = await scanPostPage(page);

    if (scan.playButtonPresent || scan.videoCandidates.length === 0) {
      await triggerVideoPlayback(page);
      await page.waitForTimeout(2500);
      scan = await scanPostPage(page);
    }

    return {
      videoCandidates: uniqByUrl([
        ...scan.videoCandidates,
        ...Array.from(videoRequestUrls, (videoUrl) => ({ url: videoUrl })),
      ]),
      documentManifestUrl: Array.from(documentManifestUrls)[0] || null,
      documentPdfUrl: Array.from(documentPdfUrls)[0] || null,
      hasDocumentViewer: scan.documentFrames.length > 0,
    };
  } finally {
    page.off('request', onRequest);
  }
}

async function downloadVideoCandidate(candidate, dest, ffmpegBin) {
  if (isHlsUrl(candidate.url)) {
    if (!ffmpegBin) return false;
    return ffmpegHlsToMp4(candidate.url, dest, ffmpegBin);
  }
  return downloadUrlToFile(candidate.url, dest);
}

async function resolveDocumentPdfUrl(documentManifestUrl, fallbackPdfUrl) {
  if (fallbackPdfUrl) return fallbackPdfUrl;
  if (!documentManifestUrl) return null;

  const manifest = await fetchJson(documentManifestUrl);
  if (!manifest) return null;
  return manifest.transcribedDocumentUrl || manifest.downloadUrl || null;
}

export async function enrichPostMedia(page, post, mediaDir, options = {}) {
  if (!needsPostMediaEnrichment(post)) {
    return { updated: false, added: [] };
  }

  const ffmpegBin = options.ffmpegBin === undefined ? findFfmpeg() : options.ffmpegBin;
  const prefix = getMediaPrefix(post);
  const inspect = await inspectPostPage(page, post.url);
  const added = [];

  if (!hasMediaFile(post, 'video')) {
    const selectedVideo = [...inspect.videoCandidates].sort(sortVideoCandidates)[0] || null;
    if (selectedVideo) {
      const file = `${prefix}_vid_0.mp4`;
      const dest = join(mediaDir, file);
      const ok = await downloadVideoCandidate(selectedVideo, dest, ffmpegBin);
      if (ok) {
        post.videos = [...new Set([...(post.videos || []), selectedVideo.url])];
        post.mediaFiles.push({ type: 'video', file, originalUrl: selectedVideo.url });
        added.push({ type: 'video', file, originalUrl: selectedVideo.url });
      }
    }
  }

  if (!hasMediaFile(post, 'document') && inspect.hasDocumentViewer) {
    const pdfUrl = await resolveDocumentPdfUrl(inspect.documentManifestUrl, inspect.documentPdfUrl);
    if (pdfUrl) {
      const file = `${prefix}_doc_0.pdf`;
      const dest = join(mediaDir, file);
      const ok = await downloadUrlToFile(pdfUrl, dest);
      if (ok) {
        post.mediaFiles.push({ type: 'document', file, originalUrl: pdfUrl });
        added.push({ type: 'document', file, originalUrl: pdfUrl });
      }
    }
  }

  return { updated: added.length > 0, added };
}

export function resolveFfmpegBinary() {
  return findFfmpeg();
}
