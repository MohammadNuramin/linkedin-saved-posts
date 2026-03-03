import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { MediaFilter } from "@/types/post";

interface Props {
  value: MediaFilter;
  onChange: (v: MediaFilter) => void;
}

const options: { value: MediaFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "has-image", label: "Has image" },
  { value: "no-media", label: "Text only" },
];

export function MediaTypeFilter({ value, onChange }: Props) {
  return (
    <div className="flex rounded-md border overflow-hidden">
      {options.map((opt) => (
        <Button
          key={opt.value}
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-none border-0 h-9 px-3 text-xs",
            value === opt.value && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
