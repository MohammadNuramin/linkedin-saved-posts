import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Props {
  text: string | null;
  onHashtagClick?: (tag: string) => void;
  expanded?: boolean;
}

const HASHTAG_RE = /#[\w\u00C0-\u017F]+/gi;
const PREVIEW_LENGTH = 280;

export function PostText({ text, onHashtagClick, expanded = false }: Props) {
  const [showFull, setShowFull] = useState(false);

  if (!text) return <p className="text-sm text-muted-foreground italic">No text content</p>;

  const needsTruncation = !expanded && text.length > PREVIEW_LENGTH;
  const displayText = needsTruncation && !showFull ? text.slice(0, PREVIEW_LENGTH) + "…" : text;

  const renderText = (raw: string) => {
    const parts = raw.split(HASHTAG_RE);
    const tags = raw.match(HASHTAG_RE) ?? [];
    return parts.map((part, i) => (
      <span key={i}>
        {part.split("\n").map((line, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {line}
          </span>
        ))}
        {tags[i] && (
          <Badge
            variant="secondary"
            className="mx-0.5 cursor-pointer text-xs hover:bg-primary hover:text-primary-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onHashtagClick?.(tags[i].toLowerCase());
            }}
          >
            {tags[i]}
          </Badge>
        )}
      </span>
    ));
  };

  return (
    <div className="text-sm leading-relaxed text-foreground">
      <p className="whitespace-pre-line">{renderText(displayText)}</p>
      {needsTruncation && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); setShowFull(!showFull); }}
        >
          {showFull ? "See less" : "See more"}
        </Button>
      )}
    </div>
  );
}
