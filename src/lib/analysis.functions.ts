import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AnalysisRow, GameRow } from "./lock-lab-types";
import { applyReasoning, runLockLabFormula, writeReasoning } from "./analysis-engine.server";

const Input = z.object({ gameId: z.string().uuid() });

/**
 * Returns the one stored Lock Lab analysis for a game, generating it on first
 * request. Every later caller reads the same stored row, so all users see
 * identical picks, lines and prices.
 */
export const getOrCreateAnalysis = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const existing = await supabaseAdmin
      .from("game_analyses")
      .select("*")
      .eq("game_id", data.gameId)
      .maybeSingle();
    if (existing.data) return existing.data as unknown as AnalysisRow;

    const gameResult = await supabaseAdmin
      .from("games")
      .select("*")
      .eq("id", data.gameId)
      .maybeSingle();
    if (!gameResult.data) throw new Error("Game not found");
    const game = gameResult.data as unknown as GameRow;

    const engine = runLockLabFormula(game, game.odds);
    const reasons = await writeReasoning(game, engine);
    const finished = applyReasoning(engine, reasons);

    const insert = await supabaseAdmin
      .from("game_analyses")
      .upsert(
        {
          game_id: game.id,
          sport: game.sport,
          odds_snapshot: game.odds,
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
