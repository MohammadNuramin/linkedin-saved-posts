import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Props {
  value: string;
  hashtags: string[];
  onChange: (v: string) => void;
}

export function HashtagFilter({ value, hashtags, onChange }: Props) {
  if (hashtags.length === 0) return null;
  return (
    <Select value={value || "__all__"} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
      <SelectTrigger className="w-40">
        <SelectValue placeholder="All hashtags" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All hashtags</SelectItem>
        {hashtags.slice(0, 50).map((tag) => (
          <SelectItem key={tag} value={tag}>
            {tag}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
