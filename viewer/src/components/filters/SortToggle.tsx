import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SortOrder } from "@/types/post";

interface Props {
  value: SortOrder;
  onChange: (v: SortOrder) => void;
}

export function SortToggle({ value, onChange }: Props) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as SortOrder)}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="original">Original order</SelectItem>
        <SelectItem value="newest">Newest posted first</SelectItem>
        <SelectItem value="oldest">Oldest posted first</SelectItem>
      </SelectContent>
    </Select>
  );
}
