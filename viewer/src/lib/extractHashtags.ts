const HASHTAG_RE = /#[\w\u00C0-\u017F]+/gi;

export function extractHashtags(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(HASHTAG_RE) ?? [];
  return [...new Set(matches.map((t) => t.toLowerCase()))];
}

export function getAllHashtags(texts: (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const tag of extractHashtags(text)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
}
