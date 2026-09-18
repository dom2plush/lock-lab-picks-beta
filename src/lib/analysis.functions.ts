import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AnalysisRow, GameRow } from "./lock-lab-types";
import { hasLiveOdds } from "./lock-lab-types";

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

    const stored = await readStored();

    // Analyze always asks the provider for the latest standard and derivative
    // markets before running. If that request fails, the most recently verified
    // live snapshot remains the latest available board; demo data never does.
    const { hasProviderKey, refreshGameOdds } = await import("./ingest.server");
    if (hasProviderKey() && !game.is_demo) {
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
        message: "Live sportsbook odds are unavailable for this matchup. No picks were generated.",
        propsVerified: false,
      };
    }


    // Only offers that can be proven to belong to this exact game, sportsbook
    // and snapshot reach the formula. Everything else is discarded, never
    // substituted.
    const { buildLiveAnalysis, verifiedExtras } = await import("./analysis-runner.server");
    const extra = verifiedExtras(game);
    const analysis = await buildLiveAnalysis(game, extra, stored);
    return {
      status,
      analysis,
      message: null,
      propsVerified: extra.props.length > 0,
    };
  });


/** Whether the live odds feed is configured — drives the LIVE ODDS UNAVAILABLE banner. */
export const getOddsFeedStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { hasProviderKey } = await import("./odds-provider.server");
  return { providerConnected: hasProviderKey() };
});
