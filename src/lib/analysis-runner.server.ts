/** Runs the current Lock Lab formula once against a verified live board and returns the exact priced result. */
import type { ExtraOffers } from "./analysis-engine.server";
import { runLockLabFormula } from "./analysis-engine.server";
import type { AnalysisRow, GameOdds, GameRow, MarketOffer } from "./lock-lab-types";
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

/** Everything a Lock Lab card stores, before it is tied to a saved row. */
export type AnalysisFields = Pick<
  AnalysisRow,
  | "sport"
  | "odds_snapshot"
  | "odds_captured_at"
  | "odds_book"
  | "is_live_odds"
  | "generated_at"
  | "top_bets"
  | "bad_bet"
  | "fun_bets"
  | "player_props"
  | "verdict"
  | "candidate_audit"
> & { engine_version: string };

/** Runs the formula once. Pure with respect to storage: nothing is written here. */
export async function computeLiveAnalysis(
  game: GameRow,
  extra: ExtraOffers,
  previousOdds: GameOdds | null,
): Promise<AnalysisFields> {
  const finished = await runLockLabFormula(game, game.odds, extra, previousOdds);
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

  return {
    sport: game.sport,
    engine_version: "direct-v3",
    odds_snapshot: game.odds,
    odds_captured_at: game.odds.capturedAt ?? game.odds_updated_at ?? null,
    odds_book: game.odds.bookmaker ?? null,
    is_live_odds: hasLiveOdds(game.odds) && !game.is_demo,
    generated_at: new Date().toISOString(),
    top_bets: audited.output.top_bets,
    bad_bet: null,
    fun_bets: audited.output.fun_bets,
    player_props: audited.output.player_props,
    verdict: finished.notes.verdict,
    candidate_audit: (finished.candidateAudit ?? null) as AnalysisRow["candidate_audit"],
  };
}
