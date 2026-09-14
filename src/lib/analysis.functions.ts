import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AnalysisRow, GameRow, MarketOffer } from "./lock-lab-types";
import { hasLiveOdds } from "./lock-lab-types";
import { applyReasoning, runLockLabFormula, writeReasoning } from "./analysis-engine.server";

const Input = z.object({ gameId: z.string().uuid() });

/** Odds older than this are re-pulled before the formula runs. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/**
 * Returns the stored Lock Lab analysis for a game, generating it on first
 * request and regenerating it whenever the game's odds snapshot has moved.
 * The snapshot stored on the analysis is exactly the snapshot the formula
 * priced from, and exactly what the UI renders — there is no second lookup.
 */
export const getOrCreateAnalysis = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const gameResult = await supabaseAdmin
      .from("games")
      .select("*")
      .eq("id", data.gameId)
      .maybeSingle();
    if (!gameResult.data) throw new Error("Game not found");
    let game = gameResult.data as unknown as GameRow;

    // Refresh this game's live odds if the stored snapshot is stale.
    const { hasProviderKey, refreshGameOdds } = await import("./ingest.server");
    const staleOdds =
      !game.odds_updated_at || Date.now() - new Date(game.odds_updated_at).getTime() > SNAPSHOT_TTL_MS;
    if (hasProviderKey() && !game.is_demo && game.status !== "final" && staleOdds) {
      const refreshed = await refreshGameOdds(game);
      if (refreshed) game = refreshed;
    }

    const existing = await supabaseAdmin
      .from("game_analyses")
      .select("*")
      .eq("game_id", data.gameId)
      .maybeSingle();

    const stored = existing.data as unknown as AnalysisRow | null;
    const storedCapture = stored?.odds_captured_at ?? null;
    const currentCapture = game.odds.capturedAt ?? game.odds_updated_at ?? null;
    const upToDate =
      stored &&
      (game.status === "final" || !currentCapture || storedCapture === currentCapture);
    if (stored && upToDate) return stored;

    const extra = {
      alternates: ((game.props ?? []) as MarketOffer[]).filter(
        (o) => !o.market.startsWith("player_"),
      ),
      props: ((game.props ?? []) as MarketOffer[]).filter((o) => o.market.startsWith("player_")),
    };

    const engine = runLockLabFormula(game, game.odds, extra);
    const reasons = await writeReasoning(game, engine);
    const finished = applyReasoning(engine, reasons);

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
          top_bets: finished.topBets,
          bad_bet: finished.badBet,
          fun_bets: finished.funBets,
          player_props: finished.playerProps,
        },
        { onConflict: "game_id" },
      )
      .select("*")
      .maybeSingle();

    if (insert.error) throw new Error(insert.error.message);
    return insert.data as unknown as AnalysisRow;
  });

/** Whether the live odds feed is configured — drives the LIVE ODDS UNAVAILABLE banner. */
export const getOddsFeedStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { hasProviderKey } = await import("./odds-provider.server");
  return { providerConnected: hasProviderKey() };
});
