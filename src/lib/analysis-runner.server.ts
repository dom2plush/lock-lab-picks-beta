/** Runs the current Lock Lab formula once against a verified live board and stores the exact priced result. */
import type { ExtraOffers } from "./analysis-engine.server";
import { runLockLabFormula } from "./analysis-engine.server";
import type { AnalysisRow, GameRow, MarketOffer } from "./lock-lab-types";
import { hasLiveOdds } from "./lock-lab-types";
import { enforceAuditIntegrity } from "./odds-audit";
import { verifyAlternateOffers, verifyPropOffers } from "./prop-integrity";

export function verifiedExtras(game: GameRow): ExtraOffers {
  const offers = (game.props ?? []) as MarketOffer[];
  return {
    alternates: verifyAlternateOffers(
      offers.filter((offer) => !offer.market.startsWith("player_")),
      game,
    ).verified,
    props: verifyPropOffers(
      offers.filter((offer) => offer.market.startsWith("player_")),
      game,
    ).verified,
  };
}

export async function buildLiveAnalysis(
  game: GameRow,
  extra: ExtraOffers,
  previous: AnalysisRow | null,
): Promise<AnalysisRow> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const finished = await runLockLabFormula(game, game.odds, extra, previous?.odds_snapshot ?? null);
  const audited = enforceAuditIntegrity(
    {
      odds_snapshot: game.odds,
      top_bets: finished.topBets,
      bad_bet: null,
      fun_bets: finished.funBets,
      player_props: finished.playerProps,
    },
    game.odds,
  );

  if (audited.dropped.length) {
    console.warn("Lock Lab audit dropped unverifiable picks", game.id, audited.dropped);
  }

  const currentCapture = game.odds.capturedAt ?? game.odds_updated_at ?? null;
  const result = await supabaseAdmin
    .from("game_analyses")
    .upsert(
      {
        game_id: game.id,
        sport: game.sport,
        engine_version: "direct-v2",
        odds_snapshot: game.odds as unknown as never,
        odds_captured_at: currentCapture,
        odds_book: game.odds.bookmaker ?? null,
        is_live_odds: hasLiveOdds(game.odds) && !game.is_demo,
        generated_at: new Date().toISOString(),
        top_bets: audited.output.top_bets as unknown as never,
        bad_bet: null,
        fun_bets: audited.output.fun_bets as unknown as never,
        player_props: audited.output.player_props as unknown as never,
        verdict: finished.notes.verdict,
        candidate_audit: finished.candidateAudit as unknown as never,
        top_pick_result: "pending",
        graded_at: null,
      } as never,
      { onConflict: "game_id" },
    )
    .select("*")
    .maybeSingle();

  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("The analysis could not be saved.");
  return result.data as unknown as AnalysisRow;
}