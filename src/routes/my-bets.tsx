import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";
import { supabase } from "@/integrations/supabase/client";
import type { GameRow, Result } from "@/lib/lock-lab-types";
import { formatKickoff } from "@/lib/lock-lab-types";
import { deleteTail } from "@/lib/tails.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/my-bets")({
  head: () => ({
    meta: [
      { title: "My Bets — Lock Lab" },
      {
        name: "description",
        content:
          "Your tailed Lock Lab picks, wagers and results — with only the Lock Lab leg counted toward your record.",
      },
      { property: "og:title", content: "My Bets — Lock Lab" },
      {
        property: "og:description",
        content: "Track your tailed picks, wagers and results on Lock Lab.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MyBetsPage,
});

const RESULT_STYLE: Record<Result, string> = {
  win: "bg-go-soft text-go",
  loss: "bg-stop-soft text-stop",
  push: "bg-surface text-muted-foreground",
  pending: "bg-caution-soft text-caution",
};

type TailRow = {
  id: string;
  pick_label: string;
  pick_odds: string | null;
  pick_section: string;
  bet_type: "straight" | "parlay";
  wager: number | null;
  extra_legs: { label: string; odds?: string }[];
  lock_leg_result: Result;
  created_at: string;
  games: GameRow;
};

function MyBetsPage() {
  const { user, loading } = useSession();
  const queryClient = useQueryClient();
  const remove = useServerFn(deleteTail);

  const query = useQuery({
    queryKey: ["my-tails", user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tails")
        .select("*, games!inner(*)")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as TailRow[];
    },
  });

  const tails = query.data ?? [];
  const wins = tails.filter((t) => t.lock_leg_result === "win").length;
  const losses = tails.filter((t) => t.lock_leg_result === "loss").length;
  const open = tails.filter((t) => t.lock_leg_result === "pending").length;
  const staked = tails.reduce((sum, t) => sum + (t.wager ?? 0), 0);

  if (!loading && !user) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="font-display text-3xl font-semibold">My Bets</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to see the picks you've tailed and how they're running.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <span className="eyebrow">Your slips</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">My bets</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Only the Lock Lab leg is graded — your own added legs are stored for reference.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {[
          { label: "Record", value: `${wins}–${losses}` },
          { label: "Open", value: String(open) },
          { label: "Tails", value: String(tails.length) },
          { label: "Total staked", value: staked > 0 ? `$${staked.toFixed(0)}` : "—" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border border-hairline bg-card p-4">
            <span className="eyebrow">{stat.label}</span>
            <p className="mt-1 font-display text-2xl font-semibold">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        {(loading || query.isLoading) &&
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        {tails.map((tail) => (
          <article key={tail.id} className="rounded-lg border border-hairline bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span className="eyebrow">
                  {tail.games.sport} · {tail.games.away_team} at {tail.games.home_team}
                </span>
                <p className="mt-1 font-display text-xl font-semibold">
                  {tail.pick_label}
                  {tail.pick_odds ? ` (${tail.pick_odds})` : ""}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tail.bet_type === "parlay" ? "Parlay" : "Straight"}
                  {tail.wager ? ` · $${tail.wager}` : ""} · kickoff{" "}
                  {formatKickoff(tail.games.commence_time)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase",
                    RESULT_STYLE[tail.lock_leg_result],
                  )}
                >
                  {tail.lock_leg_result}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete tail"
                  onClick={async () => {
                    try {
                      await remove({ data: { id: tail.id } });
                      await queryClient.invalidateQueries({ queryKey: ["my-tails"] });
                    } catch (error) {
                      toast.error((error as Error).message);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
            {tail.extra_legs.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {tail.extra_legs.map((leg, index) => (
                  <li
                    key={index}
                    className="rounded-full bg-surface px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {leg.label}
                    {leg.odds ? ` (${leg.odds})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
        {user && !query.isLoading && tails.length === 0 && (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            No tails yet. Run a matchup and hit Tail on a pick.
          </p>
        )}
      </div>
    </div>
  );
}
