import type { AnalysisRow, GameRow, MarketOffer, Sport } from "./lock-lab-types";
import { gradePick } from "./grading.server";
import {
  fetchEventMarkets,
  fetchInjuries,
  fetchScores,
  fetchUpcomingGames,
  hasProviderKey,
} from "./odds-provider.server";

const SPORTS: Sport[] = ["NFL", "CFB"];

export { hasProviderKey };

export type SyncReport = {
  providerConnected: boolean;
  gamesUpserted: number;
  scoresUpdated: number;
  demoGamesRetired: number;
  analysesGraded: number;
  tailsGraded: number;
  errors: string[];
};

/**
 * Pull the live odds board for one game (plus its alternate/prop markets) and
 * store it with the sportsbook and capture timestamp attached.
 */
export async function refreshGameOdds(game: GameRow): Promise<GameRow | null> {
  if (!hasProviderKey() || game.is_demo) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  try {
    const [board, injuriesByTeam] = await Promise.all([
      fetchUpcomingGames(game.sport),
      fetchInjuries(game.sport),
    ]);
    const match = board.find((g) => g.provider_game_id === game.provider_game_id);
    if (!match) return null;

    let props: MarketOffer[] = [];
    let propsUpdatedAt: string | null = null;
    try {
      const markets = await fetchEventMarkets(game.sport, game.provider_game_id);
      props = [...markets.alternates, ...markets.props];
      // Always stamp the pull, even when the board came back empty: that is the
      // difference between "no alternate market exists" and "never asked".
      propsUpdatedAt = markets.capturedAt;
      console.info(
        `[odds] derivative coverage ${game.away_team} @ ${game.home_team}:`,
        JSON.stringify(markets.coverage),
      );
    } catch {
      // Derivative markets are optional; the main board still stands.
    }

    const update = {
      odds: match.odds,
      odds_book: match.odds_book,
      odds_book_key: match.odds_book_key,
      odds_updated_at: match.odds_updated_at,
      injuries: [
        ...(injuriesByTeam.get(game.home_team) ?? []),
        ...(injuriesByTeam.get(game.away_team) ?? []),
      ],
      ...(propsUpdatedAt ? { props, props_updated_at: propsUpdatedAt } : {}),
      updated_at: new Date().toISOString(),
    };


    const { data, error } = await supabaseAdmin
      .from("games")
      .update(update as never)
      .eq("id", game.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as GameRow) ?? null;
  } catch (error) {
    console.error("[odds] single-game refresh failed", (error as Error).message);
    return null;
  }
}

/**
 * Full ingestion pass: schedules + odds, injuries, final scores, then grading.
 * Once live games land for a sport, the seeded demo fixtures for that sport are
 * retired so sample lines can never sit next to real ones.
 */
export async function syncSportsData(): Promise<SyncReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: SyncReport = {
    providerConnected: hasProviderKey(),
    gamesUpserted: 0,
    scoresUpdated: 0,
    demoGamesRetired: 0,
    analysesGraded: 0,
    tailsGraded: 0,
    errors: [],
  };

  if (report.providerConnected) {
    for (const sport of SPORTS) {
      let liveGames = 0;
      try {
        const [games, injuries] = await Promise.all([
          fetchUpcomingGames(sport),
          fetchInjuries(sport),
        ]);
        const rows = games.map((game) => ({
          ...game,
          injuries: [
            ...(injuries.get(game.home_team) ?? []),
            ...(injuries.get(game.away_team) ?? []),
          ],
          updated_at: new Date().toISOString(),
        }));
        if (rows.length) {
          const { error } = await supabaseAdmin
            .from("games")
            .upsert(rows as never, { onConflict: "sport,provider_game_id" });
          if (error) throw new Error(error.message);
          report.gamesUpserted += rows.length;
          liveGames = rows.length;
        }
      } catch (error) {
        report.errors.push(`${sport} odds: ${(error as Error).message}`);
      }

      if (liveGames > 0) {
        const { data: retired } = await supabaseAdmin
          .from("games")
          .delete()
          .eq("sport", sport)
          .eq("is_demo", true)
          .neq("status", "final")
          .select("id");
        report.demoGamesRetired += retired?.length ?? 0;
      }

      try {
        const scores = await fetchScores(sport);
        for (const score of scores) {
          const { error } = await supabaseAdmin
            .from("games")
            .update({
              status: score.status,
              home_score: score.home_score,
              away_score: score.away_score,
              updated_at: new Date().toISOString(),
            })
            .eq("sport", sport)
            .eq("provider_game_id", score.provider_game_id);
          if (!error) report.scoresUpdated += 1;
        }
      } catch (error) {
        report.errors.push(`${sport} scores: ${(error as Error).message}`);
      }
    }
  }

  // ---- grade ungraded #1 picks and the Lock Lab leg of every tail ----
  const { data: pending } = await supabaseAdmin
    .from("game_analyses")
    .select("*, games!inner(*)")
    .eq("top_pick_result", "pending")
    .eq("games.status", "final");

  for (const row of (pending ?? []) as unknown as (AnalysisRow & { games: GameRow })[]) {
    const result = gradePick(row.top_bets?.[0], row.games);
    if (result === "pending") continue;
    await supabaseAdmin
      .from("game_analyses")
      .update({ top_pick_result: result, graded_at: new Date().toISOString() })
      .eq("id", row.id);
    report.analysesGraded += 1;
  }

  const { data: openTails } = await supabaseAdmin
    .from("tails")
    .select("id, pick_key, analysis_id, games!inner(*), game_analyses!inner(top_bets)")
    .eq("lock_leg_result", "pending")
    .eq("games.status", "final");

  for (const tail of (openTails ?? []) as unknown as {
    id: string;
    pick_key: string;
    games: GameRow;
    game_analyses: { top_bets: AnalysisRow["top_bets"] };
  }[]) {
    const pick = tail.game_analyses.top_bets?.find((p) => p.key === tail.pick_key);
    const result = gradePick(pick, tail.games);
    if (result === "pending") continue;
    await supabaseAdmin.from("tails").update({ lock_leg_result: result }).eq("id", tail.id);
    report.tailsGraded += 1;
  }

  return report;
}
