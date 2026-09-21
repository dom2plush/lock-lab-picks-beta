import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AnalysisOutput } from "@/components/analysis-output";
import { GameCard } from "@/components/game-card";
import { TailDialog, type TailTarget } from "@/components/tail-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { getOddsFeedStatus, getOrCreateAnalysis } from "@/lib/analysis.functions";
import type { AnalysisRow, GameRow, Sport } from "@/lib/lock-lab-types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Lock Lab — NFL & College Football Betting Analysis" },
      {
        name: "description",
        content:
          "Run the live Lock Lab formula for NFL and college football: top 2 bets, supported player props and one fun bet with exact lines logged.",
      },
      { property: "og:title", content: "Lock Lab — NFL & College Football Betting Analysis" },
      {
        property: "og:description",
        content:
          "Top 2 bets, supported player props and one fun bet for NFL and college football matchups.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AnalyzePage,
});

function AnalyzePage() {
  const [sport, setSport] = useState<Sport>("NFL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{
    game: GameRow;
    row: AnalysisRow | null;
    status: "pregame" | "locked" | "historical" | "unavailable";
    message: string | null;
    propsVerified: boolean;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [tailTarget, setTailTarget] = useState<TailTarget | null>(null);

  const analyze = useServerFn(getOrCreateAnalysis);
  const feedStatus = useServerFn(getOddsFeedStatus);

  const feedQuery = useQuery({
    queryKey: ["odds-feed-status"],
    queryFn: () => feedStatus({}),
  });

  const gamesQuery = useQuery({
    queryKey: ["upcoming-games", sport],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("games")
        .select("*")
        .eq("sport", sport)
        .neq("status", "final")
        .order("commence_time", { ascending: true })
        .limit(24);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as GameRow[];
    },
  });

  const games = gamesQuery.data ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return games;
    const words = term
      .split(/[^a-z0-9]+/i)
      .filter((word) => word.length > 1 && !["vs", "at", "and", "the"].includes(word));
    if (words.length === 0) return games;
    return games.filter((game) => {
      const haystack = `${game.home_team} ${game.away_team} ${game.home_team_short ?? ""} ${
        game.away_team_short ?? ""
      }`.toLowerCase();
      return words.some((word) => haystack.includes(word));
    });
  }, [games, search]);


  const selected = filtered.find((g) => g.id === selectedId) ?? games.find((g) => g.id === selectedId);

  const runAnalysis = async () => {
    const game = selected ?? filtered[0];
    if (!game) {
      toast.error("Pick a matchup first");
      return;
    }
    setRunning(true);
    try {
      const result = await analyze({ data: { gameId: game.id } });
      setSelectedId(game.id);
      setAnalysis({
        game,
        row: (result.analysis ?? null) as AnalysisRow | null,
        status: result.status,
        message: result.message,
        propsVerified: result.propsVerified,
      });
      if (result.status !== "pregame") {
        toast.message(
          result.status === "historical" ? "Final — pregame card only" : "Game in progress / picks locked",
        );
      }
    } catch (error) {
      toast.error((error as Error).message || "Analysis failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <span className="eyebrow">The Lock Lab formula</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">Analyze a matchup</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Same picks for everyone. Pick a game, run the formula, and get the two best bets on the
         board, supported player props and one smaller-unit fun bet — with the exact line logged.
      </p>

      {feedQuery.data && !feedQuery.data.providerConnected && (
        <div className="mt-5 rounded-lg border border-stop/40 bg-stop/10 p-4">
          <p className="font-display text-sm font-bold tracking-wide text-stop uppercase">
            Live odds unavailable
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            No sportsbook feed is connected yet, so the games below are sample fixtures. Add your
            odds provider key and Lock Lab will switch to real spreads, moneylines, totals and props
            automatically — nothing is ever estimated.
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-hairline bg-card p-1">
          {(["NFL", "CFB"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setSport(option);
                setSelectedId(null);
              }}
              className={
                sport === option
                  ? "rounded-md bg-primary px-4 py-1.5 font-display text-sm font-semibold text-primary-foreground"
                  : "rounded-md px-4 py-1.5 font-display text-sm font-semibold text-muted-foreground hover:text-foreground"
              }
            >
              {option}
            </button>
          ))}
        </div>

        <div className="relative min-w-[15rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Broncos vs Chiefs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <Button onClick={runAnalysis} disabled={running}>
          {running ? "Running formula…" : "Analyze Matchup"}
        </Button>
      </div>

      <h2 className="mt-8 font-display text-xl font-semibold">Featured {sport} games</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {gamesQuery.isLoading &&
          Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-36 rounded-lg" />
          ))}
        {filtered.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            selected={game.id === selectedId}
            onSelect={() => setSelectedId(game.id)}
          />
        ))}
      </div>
      {!gamesQuery.isLoading && filtered.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
          No {sport} matchups match that search.
        </p>
      )}

      {analysis && (
        <div className="mt-12 space-y-6">
          {analysis.status !== "pregame" && (
            <div className="rounded-lg border border-stop/40 bg-stop/10 p-4">
              <p className="font-display text-sm font-bold tracking-wide text-stop uppercase">
                {analysis.status === "historical"
                  ? "Final — pregame picks only"
                  : analysis.status === "unavailable"
                    ? "Live odds unavailable"
                    : "Game in progress / picks locked"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{analysis.message}</p>
            </div>
          )}

          {analysis.row && (
            <AnalysisOutput
              game={analysis.game}
              analysis={analysis.row}
              status={analysis.status}
              propsVerified={analysis.propsVerified}
              onTail={(target) => setTailTarget(target)}
            />
          )}
        </div>
      )}

      <TailDialog target={tailTarget} onClose={() => setTailTarget(null)} />
    </div>
  );
}
