import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { getAllHashtags } from "@/lib/extractHashtags";
import type { Post } from "@/types/post";

interface Props {
  posts: Post[];
  open: boolean;
  onClose: () => void;
}

export function StatsPanel({ posts, open, onClose }: Props) {
  const withMedia = posts.filter((p) => p.mediaFiles.length > 0).length;
  const withText = posts.filter((p) => p.text && p.text.length > 0).length;

  // Top authors by post count
  const authorCounts = new Map<string, number>();
  for (const p of posts) authorCounts.set(p.author, (authorCounts.get(p.author) ?? 0) + 1);
  const topAuthors = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxCount = topAuthors[0]?.[1] ?? 1;

  const topHashtags = getAllHashtags(posts.map((p) => p.text)).slice(0, 20);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Post Statistics</DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-1">
          <div className="space-y-5 pr-2">
            {/* Overview */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total posts", value: posts.length },
                { label: "With images", value: withMedia },
                { label: "Text only", value: posts.length - withMedia },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border p-3 text-center">
                  <p className="text-2xl font-bold">{value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                </div>
              ))}
            </div>

            <Separator />

            {/* Top authors */}
            <div>
              <p className="font-semibold text-sm mb-3">Top Authors</p>
              <div className="space-y-2">
                {topAuthors.map(([author, count]) => (
                  <div key={author} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="truncate max-w-[200px]">{author}</span>
                      <span className="text-muted-foreground ml-2 shrink-0">{count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {topHashtags.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="font-semibold text-sm mb-3">Top Hashtags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {topHashtags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            )}

            <Separator />
            <div className="text-xs text-muted-foreground pb-2">
              {withText} of {posts.length} posts have text content.
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
