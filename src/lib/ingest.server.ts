import type { AnalysisRow, GameRow, Sport } from "./lock-lab-types";
import { gradePick } from "./grading.server";
import {
  fetchInjuries,
  fetchScores,
  fetchUpcomingGames,
  hasProviderKey,
} from "./odds-provider.server";

const SPORTS: Sport[] = ["NFL", "CFB"];

export type SyncReport = {
  providerConnected: boolean;
  gamesUpserted: number;
  scoresUpdated: number;
  analysesGraded: number;
  tailsGraded: number;
  errors: string[];
};

/**
 * Full ingestion pass: schedules + odds, injuries, final scores, then grading.
 * With no provider key configured this becomes a grading-only pass so the seeded
 * demo schedule is left untouched.
 */
export async function syncSportsData(): Promise<SyncReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: SyncReport = {
    providerConnected: hasProviderKey(),
    gamesUpserted: 0,
    scoresUpdated: 0,
    analysesGraded: 0,
    tailsGraded: 0,
    errors: [],
  };

  if (report.providerConnected) {
    for (const sport of SPORTS) {
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
            .upsert(rows, { onConflict: "sport,provider_game_id" });
          if (error) throw new Error(error.message);
          report.gamesUpserted += rows.length;
        }
      } catch (error) {
        report.errors.push(`${sport} odds: ${(error as Error).message}`);
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
