import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AnalysisRow, GameRow, MarketOffer } from "./lock-lab-types";
import type { SimAggregate } from "./simulation.server";
import { hasLiveOdds } from "./lock-lab-types";
import { runLockLabFormula } from "./analysis-engine.server";
import { enforceAuditIntegrity } from "./odds-audit";
import { verifyAlternateOffers, verifyPropOffers } from "./prop-integrity";

const Input = z.object({ gameId: z.string().uuid() });

/** Odds older than this are re-pulled before the formula runs. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export type AnalysisStatus = "pregame" | "locked" | "historical" | "unavailable";

export type AnalysisResponse = {
  status: AnalysisStatus;
  /** Null only when kickoff has passed and no pregame analysis was ever saved. */
  analysis: AnalysisRow | null;
  /** Shown verbatim when picks are locked. */
  message: string | null;
  /** Whether the live feed returned any prop that passed verification. */
  propsVerified: boolean;
  /** Stored 50-run simulation summary for this board, when one exists. */
  simulations?: { runs: number; aggregate: SimAggregate | null; fresh: boolean } | null;
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

    // Refresh this game's live odds if the stored snapshot is stale, or if the
    // alternate/prop board has never been pulled for it. A pull that legitimately
    // returns nothing stamps props_updated_at, so we do not re-ask every visit.
    const { hasProviderKey, refreshGameOdds } = await import("./ingest.server");
    const staleOdds =
      !game.odds_updated_at || Date.now() - new Date(game.odds_updated_at).getTime() > SNAPSHOT_TTL_MS;
    const derivativesNeverPulled = !game.props_updated_at;
    const staleDerivatives =
      !!game.props_updated_at &&
      Date.now() - new Date(game.props_updated_at).getTime() > SNAPSHOT_TTL_MS;
    if (
      hasProviderKey() &&
      !game.is_demo &&
      (staleOdds || derivativesNeverPulled || staleDerivatives)
    ) {
      const refreshed = await refreshGameOdds(game);
      if (refreshed) game = refreshed;
    }

    // ---- production path is live data only ----
    // Sample fixtures and snapshot-less rows never reach the formula: Lock Lab
    // says the feed is missing rather than analysing a market that isn't real.
    if (game.is_demo || !hasLiveOdds(game.odds)) {
      return {
        status: "unavailable",
        analysis: null,
        message:
          "DATA CONNECTION REQUIRED — no live sportsbook odds are connected for this game, so Lock Lab has no real market to analyse.",
        propsVerified: false,
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

    const stored = await readStored();

    // Clicking Analyze never re-runs the formula. The weekly cycle has already
    // executed it once for this input state and stored the 50-simulation batch;
    // as long as the inputs still fingerprint the same, the stored board and
    // aggregate are returned instantly.
    const { simulationFingerprint, batchIsCurrent, readStoredBatch } = await import(
      "./simulation.server"
    );
    const fingerprint = simulationFingerprint(game, game.odds, extra);
    const batch = await readStoredBatch(game.id);
    if (stored && batchIsCurrent(batch, fingerprint)) {
      return {
        status,
        analysis: stored,
        message: null,
        propsVerified: hasVerifiedProps(game),
        simulations: { runs: batch?.runs ?? 0, aggregate: (batch?.aggregate as SimAggregate | undefined) ?? null, fresh: false },
      };
    }

    // No current batch for these inputs (first look at this game, or a material
    // input change such as line movement or injury news): build one now.
    const { buildAnalysisBatch } = await import("./simulation-runner.server");
    const built = await buildAnalysisBatch(game, extra, stored);
    return {
      status,
      analysis: built.analysis,
      message: null,
      propsVerified: extra.props.length > 0,
      simulations: { runs: built.batch.simulations.length, aggregate: built.batch.aggregate, fresh: true },
    };
  });


/** Whether the live odds feed is configured — drives the LIVE ODDS UNAVAILABLE banner. */
export const getOddsFeedStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { hasProviderKey } = await import("./odds-provider.server");
  return { providerConnected: hasProviderKey() };
});
