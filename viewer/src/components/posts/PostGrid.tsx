import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PostCard } from "./PostCard";
import type { Post } from "@/types/post";

const PAGE_SIZE = 24;

interface Props {
  posts: Post[];
  onSelectPost: (p: Post) => void;
  onHashtagClick: (tag: string) => void;
  onDeletePost: (index: number) => void;
  onDeleteAuthor: (author: string) => void;
}

export function PostGrid({ posts, onSelectPost, onHashtagClick, onDeletePost, onDeleteAuthor }: Props) {
  const [page, setPage] = useState(0);

  // Reset to page 0 when filtered results change
  useEffect(() => { setPage(0); }, [posts]);

  const totalPages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  const pagePosts = posts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-2">
        <p className="text-lg font-medium">No posts found</p>
        <p className="text-sm">Try adjusting your filters</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {pagePosts.map((post) => (
          <PostCard
            key={post.index}
            post={post}
            onSelect={onSelectPost}
            onHashtagClick={onHashtagClick}
            onDelete={() => onDeletePost(post.index)}
            onDeleteAuthor={() => onDeleteAuthor(post.author)}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
