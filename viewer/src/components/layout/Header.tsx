import { Moon, Sun, BarChart2, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  darkMode: boolean;
  onToggleDark: () => void;
  totalCount: number;
  filteredCount: number;
  onShowStats: () => void;
  onShowScheduler: () => void;
}

export function Header({ darkMode, onToggleDark, totalCount, filteredCount, onShowStats, onShowScheduler }: Props) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-4">
        <div className="flex items-center gap-2">
          {/* LinkedIn logo */}
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-[#0A66C2]">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
          </svg>
          <span className="font-semibold text-sm hidden sm:block">Saved Posts</span>
        </div>

        <Badge variant="secondary" className="ml-0">
          {filteredCount === totalCount
            ? `${totalCount} posts`
            : `${filteredCount} of ${totalCount}`}
        </Badge>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onShowStats}>
                <BarChart2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stats</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onShowScheduler}>
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Scheduler &amp; Sync</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onToggleDark}>
                {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{darkMode ? "Light mode" : "Dark mode"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
