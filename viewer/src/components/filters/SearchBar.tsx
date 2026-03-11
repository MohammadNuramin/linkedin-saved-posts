import { useState, useEffect, useCallback } from "react";
import { Search, X, Sparkles, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSemanticSearch?: (query: string) => void;
  onClearSemantic?: () => void;
  semanticActive?: boolean;
  semanticLoading?: boolean;
}

export function SearchBar({ value, onChange, onSemanticSearch, onClearSemantic, semanticActive, semanticLoading }: Props) {
  const [local, setLocal] = useState(value);

  useEffect(() => { setLocal(value); }, [value]);

  useEffect(() => {
    if (!semanticActive) {
      const id = setTimeout(() => { onChange(local); }, 200);
      return () => clearTimeout(id);
    }
  }, [local, onChange, semanticActive]);

  const handleSemanticSearch = useCallback(() => {
    if (local.trim() && onSemanticSearch) {
      onSemanticSearch(local.trim());
    }
  }, [local, onSemanticSearch]);

  const handleClear = useCallback(() => {
    setLocal("");
    onChange("");
    onClearSemantic?.();
  }, [onChange, onClearSemantic]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && local.trim() && onSemanticSearch) {
      e.preventDefault();
      handleSemanticSearch();
    }
  }, [local, onSemanticSearch, handleSemanticSearch]);

  return (
    <div className="relative flex-1 min-w-48 flex gap-1">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={semanticActive ? "AI search active" : "Search posts… (Enter for AI search)"}
          value={local}
          onChange={(e) => { setLocal(e.target.value); onClearSemantic?.(); }}
          onKeyDown={handleKeyDown}
          className={`pl-9 pr-8 ${semanticActive ? "border-purple-400 dark:border-purple-500" : ""}`}
        />
        {(local || semanticActive) && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={handleClear}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      {onSemanticSearch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={semanticActive ? "default" : "outline"}
              size="icon"
              onClick={handleSemanticSearch}
              disabled={!local.trim() || semanticLoading}
              className={semanticActive ? "bg-purple-600 hover:bg-purple-700 text-white" : ""}
            >
              {semanticLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>AI semantic search (Enter)</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
