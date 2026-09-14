import type { Badge } from "@/lib/lock-lab-types";
import { BADGE_LABEL } from "@/lib/lock-lab-types";
import { cn } from "@/lib/utils";

const STYLES: Record<Badge, string> = {
  green: "bg-go-soft text-go border-go/30",
  yellow: "bg-caution-soft text-caution border-caution/35",
  red: "bg-stop-soft text-stop border-stop/30",
};

const DOT: Record<Badge, string> = {
  green: "bg-go",
  yellow: "bg-caution",
  red: "bg-stop",
};

export function BadgePill({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.09em]",
        STYLES[badge],
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", DOT[badge])} aria-hidden />
      {BADGE_LABEL[badge]}
    </span>
  );
}
