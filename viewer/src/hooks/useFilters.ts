import { useMemo } from "react";
import type { Post, FilterState } from "@/types/post";
import { parseTimestampAge } from "@/lib/parseTimestamp";
import { extractHashtags, getAllHashtags } from "@/lib/extractHashtags";

interface UseFiltersResult {
  filteredPosts: Post[];
  allAuthors: string[];
  allHashtags: string[];
}

export function useFilters(posts: Post[], state: FilterState): UseFiltersResult {
  const allAuthors = useMemo(
    () =>
      [...new Set(posts.map((p) => p.author).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [posts]
  );

  const allHashtags = useMemo(
    () => getAllHashtags(posts.map((p) => p.text)),
    [posts]
  );

  const filteredPosts = useMemo(() => {
    let result = [...posts];

    // Semantic search overrides text search when active
    if (state.semanticResults) {
      const indexSet = new Set(state.semanticResults);
      const indexOrder = new Map(state.semanticResults.map((idx, i) => [idx, i]));
      result = result
        .filter(p => indexSet.has(p.index))
        .sort((a, b) => (indexOrder.get(a.index) ?? 999) - (indexOrder.get(b.index) ?? 999));
    } else if (state.search.trim()) {
      const q = state.search.toLowerCase();
      result = result.filter(
        (p) =>
          p.text?.toLowerCase().includes(q) ||
          p.author?.toLowerCase().includes(q)
      );
    }

    if (state.author) {
      result = result.filter((p) => p.author === state.author);
    }

    if (state.hashtag) {
      result = result.filter((p) =>
        extractHashtags(p.text).includes(state.hashtag)
      );
    }

    if (state.mediaType === "has-image") {
      result = result.filter((p) => p.mediaFiles.length > 0);
    } else if (state.mediaType === "no-media") {
      result = result.filter((p) => p.mediaFiles.length === 0);
    }

    if (state.sortOrder === "newest") {
      result.sort(
        (a, b) => parseTimestampAge(a.timestamp) - parseTimestampAge(b.timestamp)
      );
    } else if (state.sortOrder === "oldest") {
      result.sort(
        (a, b) => parseTimestampAge(b.timestamp) - parseTimestampAge(a.timestamp)
      );
    }

    return result;
  }, [posts, state.search, state.author, state.hashtag, state.mediaType, state.sortOrder, state.semanticResults]);

  return { filteredPosts, allAuthors, allHashtags };
}
