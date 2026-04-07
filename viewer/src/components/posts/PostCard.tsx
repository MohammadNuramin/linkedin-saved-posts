import { memo } from "react";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PostText } from "./PostText";
import { PostMedia } from "./PostMedia";
import { PostActions } from "./PostActions";
import { getInitials } from "@/lib/utils";
import { isRepost, getRepostAuthor, getDisplayTimestamp } from "@/lib/parseTimestamp";
import type { Post } from "@/types/post";

interface Props {
  post: Post;
  onSelect: (p: Post) => void;
  onHashtagClick: (tag: string) => void;
  onDelete: () => void;
  onDeleteAuthor: () => void;
}

export const PostCard = memo(function PostCard({ post, onSelect, onHashtagClick, onDelete, onDeleteAuthor }: Props) {
  const repost = isRepost(post.timestamp);
  const displayTime = getDisplayTimestamp(post);

  return (
    <Card
      className="flex flex-col h-full cursor-pointer transition-shadow hover:shadow-md"
      onClick={() => onSelect(post)}
    >
      <CardHeader className="pb-2 space-y-0">
        <div className="flex items-start gap-3">
          <Avatar className="h-9 w-9 shrink-0">
            {post.authorImage && <AvatarImage src={post.authorImage} alt={post.author} />}
            <AvatarFallback className="text-xs">{getInitials(post.author)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight truncate">{post.author}</p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {repost && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  Repost - {getRepostAuthor(post.timestamp)}
                </Badge>
              )}
              {displayTime && (
                <span className="text-xs text-muted-foreground">{displayTime}</span>
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pb-2">
        <PostText text={post.text} onHashtagClick={onHashtagClick} />
        <PostMedia mediaFiles={post.mediaFiles} onExpand={() => onSelect(post)} />
      </CardContent>

      <Separator />
      <CardFooter className="py-1 px-4">
        <PostActions post={post} onExpand={() => onSelect(post)} onDelete={onDelete} onDeleteAuthor={onDeleteAuthor} />
      </CardFooter>
    </Card>
  );
});
