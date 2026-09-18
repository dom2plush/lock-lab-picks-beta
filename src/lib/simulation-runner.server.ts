/**
 * Builds one analysis + 50-simulation batch for a game and stores both.
 *
 * Exactly one Lock Lab formula run (one model call) happens here. The 50
 * simulations are deterministic executions of that formula's settlement math
 * against seeded game outcomes — never 50 separate AI prompts.
 */
import type { AnalysisRow, GameRow } from "./lock-lab-types";
import { hasLiveOdds } from "./lock-lab-types";
import type { ExtraOffers } from "./analysis-engine.server";
import { runLockLabFormula } from "./analysis-engine.server";
import { enforceAuditIntegrity } from "./odds-audit";
import {
  batchIsCurrent,
  readStoredBatch,
  simulateBoard,
  simulationFingerprint,
  storeBatch,
  type SimulationBatch,
} from "./simulation.server";
import { verifyAlternateOffers, verifyPropOffers } from "./prop-integrity";
import type { MarketOffer } from "./lock-lab-types";

export type BuiltAnalysis = { analysis: AnalysisRow; batch: SimulationBatch };

function impliedProbability(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/** Verified alternate/prop offers for a game, exactly as the formula sees them. */
export function verifiedExtras(game: GameRow): ExtraOffers {
  const offers = (game.props ?? []) as MarketOffer[];
  return {
    alternates: verifyAlternateOffers(
      offers.filter((o) => !o.market.startsWith("player_")),
      game,
    ).verified,
    props: verifyPropOffers(
      offers.filter((o) => o.market.startsWith("player_")),
      game,
    ).verified,
  };
}

export async function buildAnalysisBatch(
  game: GameRow,
  extra: ExtraOffers,
  previous: AnalysisRow | null,
): Promise<BuiltAnalysis> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const finished = await runLockLabFormula(game, game.odds, extra, previous?.odds_snapshot ?? null);

  const fingerprint = simulationFingerprint(game, game.odds, extra);
  const initialBatch = simulateBoard(game, game.odds, finished, fingerprint);
  const valuablePropKeys = new Set(
    initialBatch.aggregate.selections
      .filter((selection) => {
        if (selection.section !== "prop" || selection.simulatedProb == null) return false;
        const implied = impliedProbability(selection.price);
        return implied != null && selection.simulatedProb > implied;
      })
      .map((selection) => selection.key),
  );

  const audited = enforceAuditIntegrity(
    {
      odds_snapshot: game.odds,
      top_bets: finished.topBets,
      bad_bet: null,
      fun_bets: finished.funBets,
      player_props: finished.playerProps.filter((prop) => valuablePropKeys.has(prop.key)).slice(0, 3),
    },
    game.odds,
  );
  if (audited.dropped.length) {
    console.warn("Lock Lab audit dropped unverifiable picks", game.id, audited.dropped);
  }

  const verdict =
    finished.notes.verdict ??
    (audited.output.top_bets.length
      ? null
      : "No pick on this board could be reconciled with the displayed odds snapshot, so Lock Lab is passing.");

  const currentCapture = game.odds.capturedAt ?? game.odds_updated_at ?? null;
  const insert = await supabaseAdmin
    .from("game_analyses")
    .upsert(
      {
        game_id: game.id,
        sport: game.sport,
        odds_snapshot: game.odds as unknown as never,
        odds_captured_at: currentCapture,
        odds_book: game.odds.bookmaker ?? null,
        is_live_odds: hasLiveOdds(game.odds) && !game.is_demo,
        generated_at: new Date().toISOString(),
        top_bets: audited.output.top_bets as unknown as never,
        bad_bet: audited.output.bad_bet as unknown as never,
        fun_bets: audited.output.fun_bets as unknown as never,
        player_props: audited.output.player_props as unknown as never,
        verdict,
        candidate_audit: finished.candidateAudit as unknown as never,
      } as never,
      { onConflict: "game_id" },
    )
    .select("*")
    .maybeSingle();

  if (insert.error) throw new Error(insert.error.message);
  const analysis = insert.data as unknown as AnalysisRow;

  // 50 deterministic executions of this board, stored in full.
  const batch = simulateBoard(
    game,
    game.odds,
    {
      ...finished,
      topBets: audited.output.top_bets,
      funBets: audited.output.fun_bets,
      playerProps: audited.output.player_props,
    },
    fingerprint,
  );
  await storeBatch(game, batch, analysis?.id ?? null);

  return { analysis, batch };
}

/**
 * Weekly-cycle entry point for one game: builds a batch only when the current
 * inputs have no stored batch yet. Duplicate work is skipped, so the model is
 * called at most once per material input change.
 */
export async function ensureSimulationBatch(
  game: GameRow,
): Promise<"created" | "skipped" | "no-live-odds"> {
  if (game.is_demo || !hasLiveOdds(game.odds)) return "no-live-odds";
  const extra = verifiedExtras(game);
  const fingerprint = simulationFingerprint(game, game.odds, extra);
  const existing = await readStoredBatch(game.id);
  if (batchIsCurrent(existing, fingerprint)) return "skipped";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const stored = await supabaseAdmin
    .from("game_analyses")
    .select("*")
    .eq("game_id", game.id)
    .maybeSingle();

  await buildAnalysisBatch(game, extra, (stored.data as unknown as AnalysisRow | null) ?? null);
  return "created";
}
