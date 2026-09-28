import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

import type { PublicBetting } from "./lock-lab-types";

/**
 * Optional manual public-betting inputs. Percentages describe the home side
 * (spread, moneyline) and the over (total). Every field may be left blank, and
 * a blank field is ignored by the model rather than guessed at.
 */
const Pct = z.number().min(0).max(100).nullable().optional();

const SaveInput = z.object({
  gameId: z.string().uuid(),
  spreadBetPct: Pct,
  spreadMoneyPct: Pct,
  mlBetPct: Pct,
  mlMoneyPct: Pct,
  totalBetPct: Pct,
  totalMoneyPct: Pct,
  /** When the split was observed; defaults to now. */
  recordedAt: z.string().datetime().nullable().optional(),
});

export const getPublicBetting = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ gameId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ input: PublicBetting | null }> => {
    const { readPublicBetting } = await import("./public-betting.server");
    return { input: await readPublicBetting(data.gameId) };
  });

export const savePublicBetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveInput.parse(input))
  .handler(async ({ data, context }): Promise<{ input: PublicBetting | null }> => {
    const { toPublicBetting } = await import("./public-betting.server");
    const value = (v: number | null | undefined) => (typeof v === "number" ? v : null);
    const row = {
      game_id: data.gameId,
      spread_bet_pct: value(data.spreadBetPct),
      spread_money_pct: value(data.spreadMoneyPct),
      ml_bet_pct: value(data.mlBetPct),
      ml_money_pct: value(data.mlMoneyPct),
      total_bet_pct: value(data.totalBetPct),
      total_money_pct: value(data.totalMoneyPct),
      recorded_at: data.recordedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: context.userId,
    };
    const { data: saved, error } = await context.supabase
      .from("public_betting_inputs")
      .upsert(row, { onConflict: "game_id" })
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { input: toPublicBetting(saved as never) };
  });

export const clearPublicBetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ gameId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("public_betting_inputs")
      .delete()
      .eq("game_id", data.gameId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
