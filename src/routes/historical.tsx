import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { BadgePill } from "@/components/badge-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import type { AnalysisRow, GameRow, Result, Sport } from "@/lib/lock-lab-types";
import { formatKickoff } from "@/lib/lock-lab-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/historical")({
  head: () => ({
    meta: [
      { title: "Historical Games — Lock Lab" },
      {
        name: "description",
        content:
          "Every graded Lock Lab pick: the pre-game call, the exact odds at the time, the final score and whether the #1 pick hit.",
      },
      { property: "og:title", content: "Historical Games — Lock Lab" },
      {
        property: "og:description",
        content: "Pre-game Lock Lab picks, the exact odds logged, final scores and results.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HistoricalPage,
});

const RESULT_STYLE: Record<Result, string> = {
  win: "bg-go-soft text-go",
  loss: "bg-stop-soft text-stop",
  push: "bg-surface text-muted-foreground",
  pending: "bg-caution-soft text-caution",
};

type Row = AnalysisRow & { games: GameRow };

function HistoricalPage() {
  const [sport, setSport] = useState<Sport | "ALL">("ALL");

  const query = useQuery({
    queryKey: ["historical", sport],
    queryFn: async () => {
      let request = supabase
        .from("game_analyses")
        .select("*, games!inner(*)")
        .eq("games.status", "final")
        .order("generated_at", { ascending: false })
        .limit(60);
      if (sport !== "ALL") request = request.eq("sport", sport);
      const { data, error } = await request;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Row[];
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <span className="eyebrow">Graded board</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">Historical games</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        The pick as it was posted before kickoff, the exact price logged at the time, and how it
        finished.
      </p>

      <div className="mt-6 inline-flex rounded-lg border border-hairline bg-card p-1">
        {(["ALL", "NFL", "CFB"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSport(option)}
            className={
              sport === option
                ? "rounded-md bg-primary px-4 py-1.5 font-display text-sm font-semibold text-primary-foreground"
                : "rounded-md px-4 py-1.5 font-display text-sm font-semibold text-muted-foreground hover:text-foreground"
            }
          >
            {option === "ALL" ? "All" : option}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        {query.isLoading && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        {(query.data ?? []).map((row) => {
          const top = row.top_bets?.[0];
          const game = row.games;
          return (
            <article key={row.id} className="rounded-lg border border-hairline bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="eyebrow">
                    {game.sport} · {formatKickoff(game.commence_time)}
                  </span>
                  <h2 className="font-display text-xl font-semibold">
                    {game.away_team} at {game.home_team}
                  </h2>
                </div>
                <div className="text-right">
                  <p className="font-display text-2xl font-semibold">
                    {game.away_score} – {game.home_score}
                  </p>
                  <span
                    className={cn(
                      "mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase",
                      RESULT_STYLE[row.top_pick_result],
                    )}
                  >
                    #1 pick {row.top_pick_result}
                  </span>
                </div>
              </div>

              {top && (
                <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-display text-lg font-semibold">{top.label}</p>
                    <BadgePill badge={top.badge} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{top.reason}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Line logged pre-game: {top.line ?? "—"} at {top.odds ?? "—"}
                    {top.book ? ` · ${top.book}` : ""}
                  </p>
                </div>
              )}
            </article>
          );
        })}
        {!query.isLoading && (query.data ?? []).length === 0 && (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            No graded games yet.
          </p>
        )}
      </div>
    </div>
  );
}
