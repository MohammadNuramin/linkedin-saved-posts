import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Props {
  value: string;
  authors: string[];
  onChange: (v: string) => void;
}

export function AuthorSelect({ value, authors, onChange }: Props) {
  return (
    <Select value={value || "__all__"} onValueChange={(v) => onChange(v === "__all__" ? "" : v)}>
      <SelectTrigger className="w-48">
        <SelectValue placeholder="All authors" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All authors</SelectItem>
        {authors.map((a) => (
          <SelectItem key={a} value={a}>
            {a}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
