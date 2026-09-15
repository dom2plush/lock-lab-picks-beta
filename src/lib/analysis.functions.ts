import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AnalysisRow, GameRow, MarketOffer } from "./lock-lab-types";
import { hasLiveOdds } from "./lock-lab-types";
import { runLockLabFormula } from "./analysis-engine.server";
import { enforceAuditIntegrity } from "./odds-audit";
import { verifyAlternateOffers, verifyPropOffers } from "./prop-integrity";

const Input = z.object({ gameId: z.string().uuid() });

/** Odds older than this are re-pulled before the formula runs. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export type AnalysisStatus = "pregame" | "locked" | "historical";

export type AnalysisResponse = {
  status: AnalysisStatus;
  /** Null only when kickoff has passed and no pregame analysis was ever saved. */
  analysis: AnalysisRow | null;
  /** Shown verbatim when picks are locked. */
  message: string | null;
  /** Whether the live feed returned any prop that passed verification. */
  propsVerified: boolean;
};

/** Kickoff has passed — no new pregame picks may be generated. */
export function isPregame(game: Pick<GameRow, "commence_time" | "status">, now = Date.now()) {
  return game.status === "scheduled" && new Date(game.commence_time).getTime() > now;
}

/**
 * Returns the stored Lock Lab analysis for a game, generating it on first
 * request and regenerating it whenever the game's odds snapshot has moved.
 *
 * New picks are only ever created BEFORE kickoff. Once a game has started the
 * saved pregame analysis (and its exact odds snapshot) is returned unchanged;
 * nothing is regenerated with post-kickoff information.
 */
export const getOrCreateAnalysis = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }): Promise<AnalysisResponse> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const gameResult = await supabaseAdmin
      .from("games")
      .select("*")
      .eq("id", data.gameId)
      .maybeSingle();
    if (!gameResult.data) throw new Error("Game not found");
    let game = gameResult.data as unknown as GameRow;

    const pregame = isPregame(game);
    const status: AnalysisStatus = pregame
      ? "pregame"
      : game.status === "final"
        ? "historical"
        : "locked";

    const readStored = async () => {
      const existing = await supabaseAdmin
        .from("game_analyses")
        .select("*")
        .eq("game_id", data.gameId)
        .maybeSingle();
      return (existing.data as unknown as AnalysisRow | null) ?? null;
    };

    const hasVerifiedProps = (row: GameRow) =>
      verifyPropOffers(
        ((row.props ?? []) as MarketOffer[]).filter((o) => o.market.startsWith("player_")),
        row,
      ).verified.length > 0;

    // ---- post-kickoff: read-only, never regenerate ----
    if (!pregame) {
      const stored = await readStored();
      return {
        status,
        analysis: stored,
        message: stored
          ? status === "historical"
            ? "Final score is in. This is the pregame Lock Lab card exactly as it was posted, priced from the pregame odds snapshot."
            : "Game in progress / picks locked. This is the pregame Lock Lab card exactly as it was posted — no new bets are generated after kickoff."
          : "Game in progress / picks locked. No Lock Lab analysis was saved before kickoff, so there is nothing to show for this game.",
        propsVerified: stored ? stored.player_props.length > 0 : false,
      };
    }

    // Refresh this game's live odds if the stored snapshot is stale.
    const { hasProviderKey, refreshGameOdds } = await import("./ingest.server");
    const staleOdds =
      !game.odds_updated_at || Date.now() - new Date(game.odds_updated_at).getTime() > SNAPSHOT_TTL_MS;
    const missingDerivatives = !game.props || game.props.length === 0;
    if (hasProviderKey() && !game.is_demo && (staleOdds || missingDerivatives)) {
      const refreshed = await refreshGameOdds(game);
      if (refreshed) game = refreshed;
    }

    const stored = await readStored();
    const storedCapture = stored?.odds_captured_at ?? null;
    const currentCapture = game.odds.capturedAt ?? game.odds_updated_at ?? null;
    const upToDate = stored && (!currentCapture || storedCapture === currentCapture);
    if (stored && upToDate) {
      return {
        status,
        analysis: stored,
        message: null,
        propsVerified: hasVerifiedProps(game),
      };
    }

    // Only offers that can be proven to belong to this exact game, sportsbook
    // and snapshot reach the formula. Everything else is discarded, never
    // substituted.
    const offers = (game.props ?? []) as MarketOffer[];
    const alternates = verifyAlternateOffers(
      offers.filter((o) => !o.market.startsWith("player_")),
      game,
    );
    const props = verifyPropOffers(
      offers.filter((o) => o.market.startsWith("player_")),
      game,
    );
    if (alternates.rejected.length || props.rejected.length) {
      console.warn("Lock Lab rejected unverifiable market offers", game.id, {
        alternates: alternates.rejected.slice(0, 5),
        props: props.rejected.slice(0, 5),
      });
    }

    const extra = { alternates: alternates.verified, props: props.verified };

    // The previously stored snapshot is what line movement is measured against.
    const finished = await runLockLabFormula(game, game.odds, extra, stored?.odds_snapshot ?? null);

    // Hard audit gate: a pick is only published when its recorded book, line,
    // price and capture time reconcile with the snapshot the UI will display.
    const audited = enforceAuditIntegrity(
      {
        odds_snapshot: game.odds,
        top_bets: finished.topBets,
        bad_bet: finished.badBet,
        fun_bets: finished.funBets,
        player_props: finished.playerProps,
      },
      game.odds,
    );
    if (audited.dropped.length) {
      console.warn(
        "Lock Lab audit dropped unverifiable picks",
        game.id,
        audited.dropped,
        audited.report.problems,
      );
    }
    const verdict =
      finished.notes.verdict ??
      (audited.output.top_bets.length
        ? null
        : "No pick on this board could be reconciled with the displayed odds snapshot, so Lock Lab is passing.");

    const insert = await supabaseAdmin
      .from("game_analyses")
      .upsert(
        {
          game_id: game.id,
          sport: game.sport,
          odds_snapshot: game.odds,
          odds_captured_at: currentCapture,
          odds_book: game.odds.bookmaker ?? null,
          is_live_odds: hasLiveOdds(game.odds) && !game.is_demo,
          generated_at: new Date().toISOString(),
          top_bets: audited.output.top_bets,
          bad_bet: audited.output.bad_bet,
          fun_bets: audited.output.fun_bets,
          player_props: audited.output.player_props,
          verdict,
        },
        { onConflict: "game_id" },
      )
      .select("*")
      .maybeSingle();

    if (insert.error) throw new Error(insert.error.message);
    return {
      status,
      analysis: insert.data as unknown as AnalysisRow,
      message: null,
      propsVerified: extra.props.length > 0,
    };
  });

/** Whether the live odds feed is configured — drives the LIVE ODDS UNAVAILABLE banner. */
export const getOddsFeedStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { hasProviderKey } = await import("./odds-provider.server");
  return { providerConnected: hasProviderKey() };
});
