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

    if (state.search.trim()) {
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
  }, [posts, state.search, state.author, state.hashtag, state.mediaType, state.sortOrder]);

  return { filteredPosts, allAuthors, allHashtags };
}
