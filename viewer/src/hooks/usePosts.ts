import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import type { Post } from "@/types/post";

interface UsePostsResult {
  posts: Post[];
  setPosts: Dispatch<SetStateAction<Post[]>>;
  loading: boolean;
  error: string | null;
}

export function usePosts(): UsePostsResult {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/saved_posts.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Post[]>;
      })
      .then((data) => {
        setPosts(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load posts");
        setLoading(false);
      });
  }, []);

  return { posts, setPosts, loading, error };
}
