/**
 * Developer-only calibration feed.
 *
 * Returns the hidden candidate audit recorded with each analysis: what the
 * engine considered, the probability/price numbers it used, and why every
 * candidate was published or passed. Nothing here is rendered in the normal
 * Lock Lab interface.
 */
import { createServerFn } from "@tanstack/react-start";
import type { CandidateAudit } from "./analysis-engine.server";

export type AuditGame = {
  gameId: string;
  sport: string;
  matchup: string;
  commenceTime: string;
  verdict: string | null;
  topBetCount: number;
  audit: CandidateAudit | null;
};

export const getCandidateAudits = createServerFn({ method: "GET" }).handler(async (): Promise<AuditGame[]> => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("game_analyses")
    .select("game_id, sport, verdict, top_bets, candidate_audit, generated_at, games(home_team, away_team, commence_time)")
    .order("generated_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const game = (row as { games?: { home_team: string; away_team: string; commence_time: string } | null }).games;
    return {
      gameId: row.game_id as string,
      sport: row.sport as string,
      matchup: game ? `${game.away_team} at ${game.home_team}` : (row.game_id as string),
      commenceTime: game?.commence_time ?? "",
      verdict: (row.verdict as string | null) ?? null,
      topBetCount: Array.isArray(row.top_bets) ? row.top_bets.length : 0,
      audit: (row.candidate_audit as unknown as CandidateAudit | null) ?? null,
    };
  });
});
