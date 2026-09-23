import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

import type { GameRow, Result } from "./lock-lab-types";

/**
 * Tails and parlays are written only through database functions
 * (tail_pick / create_parlay). They copy the exact Lock Lab bet — line, odds,
 * sportsbook and capture time — from the stored analysis, never from the
 * browser, and lock it. The official record is computed in the database
 * (my_bet_record) from those tailed bets only.
 */

const Stake = z.number().positive("Enter a stake greater than $0").max(1_000_000);

const CreateTailInput = z.object({
  analysisId: z.string().uuid(),
  pickKey: z.string().min(1).max(40),
  stake: Stake,
});

export const createTail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateTailInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("tail_pick", {
      _analysis_id: data.analysisId,
      _pick_key: data.pickKey,
      _stake: data.stake,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

const CreateParlayInput = z.object({
  tailIds: z.array(z.string().uuid()).min(2).max(12),
  stake: Stake,
  actualOdds: z.number().int().nullable(),
  actualPayout: z.number().positive().nullable(),
});

export const createParlay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateParlayInput.parse(input))
  .handler(async ({ data, context }) => {
    const args: { _tail_ids: string[]; _stake: number; _actual_odds?: number; _actual_payout?: number } = {
      _tail_ids: data.tailIds,
      _stake: data.stake,
    };
    if (data.actualOdds != null) args._actual_odds = data.actualOdds;
    if (data.actualPayout != null) args._actual_payout = data.actualPayout;
    const { data: id, error } = await context.supabase.rpc("create_parlay", args);
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

export const deleteTail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DeleteInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("tails")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) {
      throw new Error("Only bets on games that haven't started (and aren't in a parlay) can be removed");
    }
    return { ok: true };
  });

export const deleteParlay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DeleteInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("parlays")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("Only parlays whose games haven't started can be removed");
    return { ok: true };
  });

export type RecordLine = {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  staked: number;
  profit: number;
  units: number;
  winPct: number | null;
  roi: number | null;
};

export type MyTail = {
  id: string;
  pick_label: string;
  pick_odds: string | null;
  pick_section: string;
  market: string | null;
  price: number | null;
  line_point: number | null;
  odds_book: string | null;
  odds_captured_at: string | null;
  wager: number | null;
  lock_leg_result: Result;
  created_at: string;
  games: Pick<
    GameRow,
    "id" | "sport" | "home_team" | "away_team" | "commence_time" | "status" | "home_score" | "away_score"
  >;
};

export type MyParlayLeg = {
  id: string;
  tail_id: string;
  leg_index: number;
  pick_label: string;
  pick_odds: string | null;
  price: number;
  odds_book: string | null;
  odds_captured_at: string | null;
  games: MyTail["games"];
};

export type MyParlay = {
  id: string;
  stake: number;
  leg_count: number;
  computed_odds: number;
  actual_odds: number | null;
  actual_payout: number | null;
  result: Result;
  settled_payout: number | null;
  created_at: string;
  parlay_legs: MyParlayLeg[];
};

const GAME_COLS = "id, sport, home_team, away_team, commence_time, status, home_score, away_score";
const EMPTY: RecordLine = {
  wins: 0,
  losses: 0,
  pushes: 0,
  pending: 0,
  staked: 0,
  profit: 0,
  units: 0,
  winPct: null,
  roi: null,
};

export const getMyBets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [tailsRes, parlaysRes, recordRes] = await Promise.all([
      context.supabase
        .from("tails")
        .select(
          `id, pick_label, pick_odds, pick_section, market, price, line_point, odds_book, odds_captured_at, wager, lock_leg_result, created_at, games!inner(${GAME_COLS})`,
        )
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }),
      context.supabase
        .from("parlays")
        .select(
          `id, stake, leg_count, computed_odds, actual_odds, actual_payout, result, settled_payout, created_at, parlay_legs(id, tail_id, leg_index, pick_label, pick_odds, price, odds_book, odds_captured_at, games!inner(${GAME_COLS}))`,
        )
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }),
      context.supabase.rpc("my_bet_record"),
    ]);
    if (tailsRes.error) throw new Error(tailsRes.error.message);
    if (parlaysRes.error) throw new Error(parlaysRes.error.message);
    if (recordRes.error) throw new Error(recordRes.error.message);

    const record = (recordRes.data ?? {}) as Partial<Record<"singles" | "parlays" | "combined", RecordLine>>;
    const parlays = ((parlaysRes.data ?? []) as unknown as MyParlay[]).map((p) => ({
      ...p,
      parlay_legs: [...p.parlay_legs].sort((a, b) => a.leg_index - b.leg_index),
    }));
    return {
      tails: (tailsRes.data ?? []) as unknown as MyTail[],
      parlays,
      record: {
        singles: record.singles ?? EMPTY,
        parlays: record.parlays ?? EMPTY,
        combined: record.combined ?? EMPTY,
      },
    };
  });
