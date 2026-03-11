import { useReducer, useEffect, useState, useCallback } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Header } from "@/components/layout/Header";
import { StatsPanel } from "@/components/layout/StatsPanel";
import { SchedulerSettings } from "@/components/layout/SchedulerSettings";
import { SearchBar } from "@/components/filters/SearchBar";
import { AuthorSelect } from "@/components/filters/AuthorSelect";
import { SortToggle } from "@/components/filters/SortToggle";
import { MediaTypeFilter } from "@/components/filters/MediaTypeFilter";
import { HashtagFilter } from "@/components/filters/HashtagFilter";
import { PostGrid } from "@/components/posts/PostGrid";
import { PostDetailDialog } from "@/components/modals/PostDetailDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePosts } from "@/hooks/usePosts";
import { useFilters } from "@/hooks/useFilters";
import { filterReducer, initialFilterState } from "@/store/filterReducer";
import type { FilterAction, Post } from "@/types/post";

export default function App() {
  const [state, dispatch] = useReducer(filterReducer, initialFilterState);
  const [showStats, setShowStats] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const { posts, setPosts, loading, error } = usePosts();
  const { filteredPosts, allAuthors, allHashtags } = useFilters(posts, state);

  const handleDeletePost = useCallback((index: number) => {
    setPosts(prev => prev.filter(p => p.index !== index));
    fetch(`/api/posts/${index}`, { method: 'DELETE' }).catch(() => {});
  }, [setPosts]);

  const handleDeleteAuthor = useCallback((author: string) => {
    setPosts(prev => prev.filter(p => p.author !== author));
    fetch('/api/posts/author', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author }),
    }).catch(() => {});
  }, [setPosts]);

  // Sync dark mode to <html> class
  useEffect(() => {
    document.documentElement.classList.toggle("dark", state.darkMode);
  }, [state.darkMode]);

  const d = useCallback((action: FilterAction) => dispatch(action), []);

  const hasActiveFilters =
    state.search || state.author || state.hashtag || state.mediaType !== "all";

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground animate-pulse">Loading posts…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3">
        <p className="text-destructive font-medium">Failed to load posts</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-xs text-muted-foreground">Make sure you run <code>npm run dev</code> from the <code>viewer/</code> folder.</p>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="min-h-screen bg-background">
        <Header
          darkMode={state.darkMode}
          onToggleDark={() => d({ type: "TOGGLE_DARK_MODE" })}
          totalCount={posts.length}
          filteredCount={filteredPosts.length}
          onShowStats={() => setShowStats(true)}
          onShowScheduler={() => setShowScheduler(true)}
        />

        <main className="container py-6 space-y-4">
          {/* Filter bar */}
          <div className="flex flex-wrap gap-2 items-center">
            <SearchBar
              value={state.search}
              onChange={(v) => d({ type: "SET_SEARCH", payload: v })}
            />
            <AuthorSelect
              value={state.author}
              authors={allAuthors}
              onChange={(v) => d({ type: "SET_AUTHOR", payload: v })}
            />
            <HashtagFilter
              value={state.hashtag}
              hashtags={allHashtags}
              onChange={(v) => d({ type: "SET_HASHTAG", payload: v })}
            />
            <MediaTypeFilter
              value={state.mediaType}
              onChange={(v) => d({ type: "SET_MEDIA_TYPE", payload: v })}
            />
            <SortToggle
              value={state.sortOrder}
              onChange={(v) => d({ type: "SET_SORT", payload: v })}
            />
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() => d({ type: "RESET_FILTERS" })}
              >
                Clear filters
              </Button>
            )}
          </div>

          {/* Active hashtag/author pill */}
          {(state.hashtag || state.author) && (
            <div className="flex gap-2 flex-wrap">
              {state.hashtag && (
                <Badge
                  variant="secondary"
                  className="cursor-pointer"
                  onClick={() => d({ type: "SET_HASHTAG", payload: "" })}
                >
                  {state.hashtag} ×
                </Badge>
              )}
              {state.author && (
                <Badge
                  variant="secondary"
                  className="cursor-pointer"
                  onClick={() => d({ type: "SET_AUTHOR", payload: "" })}
                >
                  {state.author} ×
                </Badge>
              )}
            </div>
          )}

          <PostGrid
            posts={filteredPosts}
            onSelectPost={(p: Post) => d({ type: "SELECT_POST", payload: p })}
            onHashtagClick={(tag: string) => d({ type: "SET_HASHTAG", payload: tag })}
            onDeletePost={handleDeletePost}
            onDeleteAuthor={handleDeleteAuthor}
          />
        </main>

        <StatsPanel
          posts={posts}
          open={showStats}
          onClose={() => setShowStats(false)}
        />

        <SchedulerSettings
          open={showScheduler}
          onClose={() => setShowScheduler(false)}
        />

        <PostDetailDialog
          post={state.selectedPost}
          onClose={() => d({ type: "SELECT_POST", payload: null })}
          onHashtagClick={(tag: string) => {
            d({ type: "SET_HASHTAG", payload: tag });
            d({ type: "SELECT_POST", payload: null });
          }}
        />
      </div>
    </TooltipProvider>
  );
}
