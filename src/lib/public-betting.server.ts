/**
 * Automatically retrieved public-betting splits (Action Network feed).
 *
 * Nothing here is ever inferred: a game with no stored row, or a row whose
 * fields are all blank, carries no public-betting input and the model ignores
 * that signal entirely.
 */
import type { GameRow, PublicBetting } from "./lock-lab-types";
import { hasPublicBetting } from "./lock-lab-types";

type Row = {
  game_id: string;
  spread_bet_pct: number | string | null;
  spread_money_pct: number | string | null;
  ml_bet_pct: number | string | null;
  ml_money_pct: number | string | null;
  total_bet_pct: number | string | null;
  total_money_pct: number | string | null;
  recorded_at: string | null;
  updated_at: string | null;
};

const num = (value: number | string | null | undefined): number | null => {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

export function toPublicBetting(row: Row | null | undefined): PublicBetting | null {
  if (!row) return null;
  const parsed: PublicBetting = {
    spreadBetPct: num(row.spread_bet_pct),
    spreadMoneyPct: num(row.spread_money_pct),
    mlBetPct: num(row.ml_bet_pct),
    mlMoneyPct: num(row.ml_money_pct),
    totalBetPct: num(row.total_bet_pct),
    totalMoneyPct: num(row.total_money_pct),
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
  return hasPublicBetting(parsed) ? parsed : null;
}

/** Reads the stored split for one game. Never throws: a failure means "none". */
export async function readPublicBetting(gameId: string): Promise<PublicBetting | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("public_betting_inputs")
      .select("*")
      .eq("game_id", gameId)
      .maybeSingle();
    return toPublicBetting(data as unknown as Row | null);
  } catch {
    return null;
  }
}

/** Returns the game with its stored public-betting split attached. */
export async function attachPublicBetting(game: GameRow): Promise<GameRow> {
  return { ...game, public_betting: await readPublicBetting(game.id) };
}
