import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ExtraLeg = z.object({
  label: z.string().min(1).max(120),
  odds: z.string().max(20).optional(),
});

const CreateTailInput = z.object({
  gameId: z.string().uuid(),
  analysisId: z.string().uuid(),
  pickKey: z.string().min(1).max(40),
  pickLabel: z.string().min(1).max(160),
  pickOdds: z.string().max(20).nullable(),
  pickSection: z.enum(["top_bets", "bad_bet", "fun_bets", "player_props"]),
  betType: z.enum(["straight", "parlay"]),
  wager: z.number().min(0).max(1000000).nullable(),
  extraLegs: z.array(ExtraLeg).max(8),
});

export const createTail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateTailInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error, data: row } = await context.supabase
      .from("tails")
      .insert({
        user_id: context.userId,
        game_id: data.gameId,
        analysis_id: data.analysisId,
        pick_key: data.pickKey,
        pick_label: data.pickLabel,
        pick_odds: data.pickOdds,
        pick_section: data.pickSection,
        bet_type: data.betType,
        wager: data.wager,
        extra_legs: data.extraLegs,
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

export const deleteTail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DeleteInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("tails")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
