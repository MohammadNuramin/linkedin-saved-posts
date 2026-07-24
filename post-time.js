const LINKEDIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function parseRelativeAgeMs(value) {
  if (!value) return null;
  const text = value.toLowerCase().trim();
  const units = [
    [/(\d+)\s*(yr?|year)s?/, 365 * 24 * 60 * 60 * 1000],
    [/(\d+)\s*(mo|month)s?/, 30 * 24 * 60 * 60 * 1000],
    [/(\d+)\s*(w|week)s?/, 7 * 24 * 60 * 60 * 1000],
    [/(\d+)\s*(d|day)s?/, 24 * 60 * 60 * 1000],
    [/(\d+)\s*(h|hour)s?/, 60 * 60 * 1000],
    [/(\d+)\s*(m|min)s?/, 60 * 1000],
  ];

  for (const [pattern, multiplier] of units) {
    const match = text.match(pattern);
    if (match) return Number(match[1]) * multiplier;
  }
  return null;
}

export function estimatePostedAt(timestamp, observedAt) {
  const ageMs = parseRelativeAgeMs(timestamp);
  const observedMs = Date.parse(observedAt);
  if (ageMs === null || !Number.isFinite(observedMs)) return null;
  return new Date(observedMs - ageMs).toISOString();
}

export function extractPostedAtFromActivityUrl(url) {
  if (!url) return null;

  const match = url.match(/activity(?:[:%3A/-]+)(\d{10,})/i);
  if (!match?.[1]) return null;

  try {
    const unixMs = Number(BigInt(match[1]) >> 22n);
    if (!Number.isFinite(unixMs) || unixMs <= 0) return null;
    return new Date(unixMs).toISOString();
  } catch {
    return null;
  }
}

export function extractPostedAtFromHtml(html) {
  if (!html) return null;

  const ldJsonScripts = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of ldJsonScripts) {
    const dateMatch = match[1].match(/"datePublished"\s*:\s*"([^"]+)"/i);
    if (dateMatch?.[1]) return dateMatch[1];
  }

  const fallbackMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  return fallbackMatch?.[1] ?? null;
}

export async function fetchPostedAt(url, fetchImpl = fetch) {
  if (!url) return null;

  const fromActivityId = extractPostedAtFromActivityUrl(url);
  if (fromActivityId) return fromActivityId;

  try {
    const res = await fetchImpl(url, {
      headers: LINKEDIN_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    return extractPostedAtFromHtml(html);
  } catch {
    return null;
  }
}

export async function enrichPostsWithPostedAt(posts, options = {}) {
  const {
    concurrency = 8,
    force = false,
    limit = Infinity,
    onProgress = () => {},
    onBatchComplete = null,
  } = options;

  const targets = posts
    .filter(post => post.url && (force || !post.postedAt))
    .slice(0, limit);
  const total = targets.length;

  if (total === 0) {
    return { total: 0, processed: 0, updated: 0 };
  }

  let processed = 0;
  let updated = 0;
  let pendingSinceBatch = 0;

  const workerCount = Math.min(concurrency, total);

  const worker = async () => {
    while (targets.length > 0) {
      const post = targets.shift();
      if (!post) break;

      const postedAt = await fetchPostedAt(post.url);
      if (postedAt && post.postedAt !== postedAt) {
        post.postedAt = postedAt;
        updated++;
        pendingSinceBatch++;
      }

      processed++;
      onProgress({ processed, total, updated, post, postedAt });

      if (onBatchComplete && pendingSinceBatch >= 25) {
        await onBatchComplete({ processed, updated });
        pendingSinceBatch = 0;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));

  if (onBatchComplete && pendingSinceBatch > 0) {
    await onBatchComplete({ processed, updated });
  }

  return { total, processed, updated };
}
