/** Convert LinkedIn relative timestamps to milliseconds (age). */
export function parseTimestampAge(ts: string): number {
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
  return Infinity; // "Reposted from X" and unknowns sort to end
}

export function isRepost(ts: string): boolean {
  return ts.toLowerCase().startsWith("reposted");
}

export function getRepostAuthor(ts: string): string {
  return ts.replace(/^reposted from\s*/i, "").trim();
}
