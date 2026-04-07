interface PostTimeLike {
  postedAt?: string | null;
  timestamp?: string | null;
}

const postedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Convert LinkedIn relative timestamps to milliseconds (age). */
export function parseTimestampAge(ts: string | null | undefined): number {
  if (!ts) return Infinity;
  const s = ts.toLowerCase().trim();
  const map: [RegExp, (n: number) => number][] = [
    [/(\d+)\s*(yr?|year)s?/, (n) => n * 365 * 24 * 3600 * 1000],
    [/(\d+)\s*(mo|month)s?/, (n) => n * 30 * 24 * 3600 * 1000],
    [/(\d+)\s*(w|week)s?/, (n) => n * 7 * 24 * 3600 * 1000],
    [/(\d+)\s*(d|day)s?/, (n) => n * 24 * 3600 * 1000],
    [/(\d+)\s*(h|hour)s?/, (n) => n * 3600 * 1000],
    [/(\d+)\s*(m|min)s?/, (n) => n * 60 * 1000],
  ];

  for (const [re, calc] of map) {
    const m = s.match(re);
    if (m) return calc(parseInt(m[1], 10));
  }

  return Infinity;
}

export function isRepost(ts: string | null | undefined): boolean {
  return (ts || "").toLowerCase().startsWith("reposted");
}

export function getRepostAuthor(ts: string | null | undefined): string {
  return (ts || "").replace(/^reposted from\s*/i, "").trim();
}

export function formatPostedAt(postedAt: string | null | undefined): string | null {
  if (!postedAt) return null;
  const ms = Date.parse(postedAt);
  if (!Number.isFinite(ms)) return null;
  return postedAtFormatter.format(ms);
}

export function getDisplayTimestamp(post: PostTimeLike): string | null {
  const postedAt = formatPostedAt(post.postedAt);
  if (postedAt) return postedAt;
  if (isRepost(post.timestamp)) return null;
  return post.timestamp || null;
}

export function getPostSortTime(post: PostTimeLike): number | null {
  const absoluteMs = post.postedAt ? Date.parse(post.postedAt) : NaN;
  if (Number.isFinite(absoluteMs)) return absoluteMs;

  const relativeAge = parseTimestampAge(post.timestamp);
  if (!Number.isFinite(relativeAge) || relativeAge === Infinity) return null;
  return Date.now() - relativeAge;
}
