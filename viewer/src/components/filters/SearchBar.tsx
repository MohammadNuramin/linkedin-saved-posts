import { useState, useEffect } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function SearchBar({ value, onChange }: Props) {
  const [local, setLocal] = useState(value);

  useEffect(() => { setLocal(value); }, [value]);

  useEffect(() => {
    const id = setTimeout(() => { onChange(local); }, 200);
    return () => clearTimeout(id);
  }, [local, onChange]);

  return (
    <div className="relative flex-1 min-w-48">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search posts or authors…"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        className="pl-9 pr-8"
      />
      {local && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
          onClick={() => { setLocal(""); onChange(""); }}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
