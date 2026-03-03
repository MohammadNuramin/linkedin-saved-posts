import { Copy, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PostText } from "@/components/posts/PostText";
import { getInitials, isDocumentImage } from "@/lib/utils";
import { isRepost, getRepostAuthor } from "@/lib/parseTimestamp";
import type { Post } from "@/types/post";

interface Props {
  post: Post | null;
  onClose: () => void;
  onHashtagClick: (tag: string) => void;
}

export function PostDetailDialog({ post, onClose, onHashtagClick }: Props) {
  const [copied, setCopied] = useState(false);

  if (!post) return null;

  const repost = isRepost(post.timestamp);
  const images = post.mediaFiles.filter((m) => m.type === "image");
  const videos = post.mediaFiles.filter((m) => m.type === "video");
  const isDoc = images.some((m) => isDocumentImage(m.originalUrl));

  const handleCopy = () => {
    if (post.text) {
      navigator.clipboard.writeText(post.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const handleHashtag = (tag: string) => {
    onHashtagClick(tag);
    onClose();
  };

  return (
    <Dialog open={!!post} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <div className="flex items-start gap-3">
            <Avatar className="h-11 w-11 shrink-0">
              {post.authorImage && <AvatarImage src={post.authorImage} alt={post.author} />}
              <AvatarFallback>{getInitials(post.author)}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold leading-tight">
                {post.authorUrl ? (
                  <a
                    href={post.authorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {post.author}
                  </a>
                ) : (
                  post.author
                )}
              </DialogTitle>
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                {repost ? (
                  <Badge variant="outline" className="text-xs">
                    Repost · {getRepostAuthor(post.timestamp)}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">{post.timestamp}</span>
                )}
                {images.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {images.length} image{images.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <Separator />

        <div className="flex-1 min-h-0 overflow-y-auto px-6">
          <div className="py-4 space-y-4">
            <PostText text={post.text} onHashtagClick={handleHashtag} expanded />

            {videos.length > 0 && (
              <div className="space-y-3">
                <Separator />
                {videos.map((m, i) => (
                  <video
                    key={i}
                    controls
                    className="w-full rounded-md bg-black"
                    onError={(e) => { (e.currentTarget).style.display = "none"; }}
                  >
                    <source src={`/media/${m.file}`} />
                    <source src={m.originalUrl} />
                  </video>
                ))}
              </div>
            )}

            {isDoc && (
              <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 text-sm text-blue-800 dark:text-blue-300">
                <FileText className="h-4 w-4 shrink-0" />
                <span>Document post — {images.length} page{images.length !== 1 ? "s" : ""} captured.{post.url ? " Open on LinkedIn to view the full document." : ""}</span>
              </div>
            )}

            {images.length > 0 && (
              <div className="space-y-2">
                <Separator />
                {images.map((m, i) => (
                  <img
                    key={i}
                    src={`/media/${m.file}`}
                    alt={`Image ${i + 1}`}
                    loading="lazy"
                    className="w-full rounded-md object-contain max-h-[600px]"
                    onError={(e) => {
                      const img = e.currentTarget;
                      if (!img.dataset.fallback) {
                        img.dataset.fallback = "1";
                        img.src = m.originalUrl; // CDN fallback
                      } else {
                        img.style.display = "none";
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <Separator />
        <div className="flex items-center justify-end gap-2 px-6 py-3">
          {post.text && (
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy className="h-3.5 w-3.5 mr-1" />
              {copied ? "Copied!" : "Copy text"}
            </Button>
          )}
          {post.url && (
            <Button size="sm" onClick={() => window.open(post.url!, "_blank", "noopener")}>
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              Open on LinkedIn
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
