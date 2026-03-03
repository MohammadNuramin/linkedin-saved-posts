import { useState } from "react";
import { Copy, ExternalLink, Expand, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Post } from "@/types/post";

interface Props {
  post: Post;
  onExpand: () => void;
  onDelete: () => void;
  onDeleteAuthor: () => void;
}

export function PostActions({ post, onExpand, onDelete, onDeleteAuthor }: Props) {
  const [copied, setCopied] = useState(false);
  const [trashHovered, setTrashHovered] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (post.text) {
      navigator.clipboard.writeText(post.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="flex items-center gap-1 w-full">
      <div className="flex items-center gap-1 flex-1">
        {post.text && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleCopy}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied!" : "Copy text"}</TooltipContent>
          </Tooltip>
        )}
        {post.url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(post.url!, "_blank", "noopener");
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open on LinkedIn</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => { e.stopPropagation(); onExpand(); }}
            >
              <Expand className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Full view</TooltipContent>
        </Tooltip>
      </div>

      {/* Trash — click to delete this post; hover reveals delete-all-by-author */}
      <div
        className="flex items-center gap-1 ml-auto"
        onMouseEnter={() => setTrashHovered(true)}
        onMouseLeave={() => setTrashHovered(false)}
      >
        {trashHovered && (
          <button
            className="text-xs text-destructive font-medium px-2 py-1 rounded hover:bg-destructive/10 transition-colors whitespace-nowrap"
            onClick={(e) => { e.stopPropagation(); onDeleteAuthor(); }}
          >
            All by {post.author}
          </button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
