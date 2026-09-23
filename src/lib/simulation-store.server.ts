/**
 * Storage for precomputed Lock Lab batches. Every 50-run batch is a permanent
 * row in game_simulations (with the full card it produced); exactly one is
 * current per game, and game_analyses holds that current card for display.
 */
import type { AnalysisFields } from "./analysis-runner.server";
import type { AnalysisRow } from "./lock-lab-types";
import type { InputSnapshot, SimulationAggregate, SimulationRun } from "./simulation.server";

export type StoredBatch = {
  id: string;
  game_id: string;
  input_fingerprint: string;
  engine_version: string;
  runs: number;
  is_current: boolean;
  generated_at: string;
  aggregate: SimulationAggregate | null;
  analysis_snapshot: AnalysisFields | null;
  input_snapshot: InputSnapshot | null;
};

export type NewBatch = {
  game_id: string;
  sport: string;
  input_fingerprint: string;
  engine_version: string;
  runs: number;
  simulations: SimulationRun[];
  aggregate: SimulationAggregate;
  analysis_snapshot: AnalysisFields;
  input_snapshot: InputSnapshot;
};

export interface SimulationStore {
  readCurrent(gameId: string): Promise<{ batch: StoredBatch | null; analysis: AnalysisRow | null }>;
  findBatch(gameId: string, fingerprint: string): Promise<StoredBatch | null>;
  /** Persists a new batch and makes it the game's current one. Older batches are kept untouched. */
  saveBatch(batch: NewBatch): Promise<StoredBatch>;
  activateBatch(gameId: string, batchId: string): Promise<void>;
  /** Writes the displayed card for a game, pointing at the batch it came from. */
  writeAnalysis(gameId: string, fields: AnalysisFields, simulationId: string): Promise<AnalysisRow>;
  claimLock(gameId: string, seconds: number): Promise<boolean>;
  releaseLock(gameId: string): Promise<void>;
}

const BATCH_COLUMNS =
  "id, game_id, input_fingerprint, engine_version, runs, is_current, generated_at, aggregate, analysis_snapshot, input_snapshot";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const supabaseSimulationStore: SimulationStore = {
  async readCurrent(gameId) {
    const db = await admin();
    const [batch, analysis] = await Promise.all([
      db.from("game_simulations").select(BATCH_COLUMNS).eq("game_id", gameId).eq("is_current", true).maybeSingle(),
      db.from("game_analyses").select("*").eq("game_id", gameId).maybeSingle(),
    ]);
    return {
      batch: (batch.data as unknown as StoredBatch | null) ?? null,
      analysis: (analysis.data as unknown as AnalysisRow | null) ?? null,
    };
  },

  async findBatch(gameId, fingerprint) {
    const db = await admin();
    const { data } = await db
      .from("game_simulations")
      .select(BATCH_COLUMNS)
      .eq("game_id", gameId)
      .eq("input_fingerprint", fingerprint)
      .maybeSingle();
    return (data as unknown as StoredBatch | null) ?? null;
  },

  async saveBatch(batch) {
    const db = await admin();
    const cleared = await db
      .from("game_simulations")
      .update({ is_current: false } as never)
      .eq("game_id", batch.game_id)
      .eq("is_current", true);
    if (cleared.error) throw new Error(cleared.error.message);

    const row = {
      ...batch,
      is_current: true,
      generated_at: new Date().toISOString(),
    };
    // A legacy row with the same fingerprint but no stored card is completed
    // in place; a row that already holds a card is immutable and reused instead.
    const saved = await db
      .from("game_simulations")
      .upsert(row as never, { onConflict: "game_id,input_fingerprint" })
      .select(BATCH_COLUMNS)
      .single();
    if (saved.error) throw new Error(saved.error.message);
    return saved.data as unknown as StoredBatch;
  },

  async activateBatch(gameId, batchId) {
    const db = await admin();
    const cleared = await db
      .from("game_simulations")
      .update({ is_current: false } as never)
      .eq("game_id", gameId)
      .eq("is_current", true)
      .neq("id", batchId);
    if (cleared.error) throw new Error(cleared.error.message);
    const set = await db.from("game_simulations").update({ is_current: true } as never).eq("id", batchId);
    if (set.error) throw new Error(set.error.message);
  },

  async writeAnalysis(gameId, fields, simulationId) {
    const db = await admin();
    const result = await db
      .from("game_analyses")
      .upsert(
        {
          game_id: gameId,
          ...fields,
          simulation_id: simulationId,
          top_pick_result: "pending",
          graded_at: null,
        } as never,
        { onConflict: "game_id" },
      )
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    return result.data as unknown as AnalysisRow;
  },

  async claimLock(gameId, seconds) {
    const db = await admin();
    const { data, error } = await db.rpc("claim_analysis_generation", { _game_id: gameId, _seconds: seconds });
    if (error) throw new Error(error.message);
    return Boolean(data);
  },

  async releaseLock(gameId) {
    const db = await admin();
    await db.from("analysis_generation_locks").delete().eq("game_id", gameId);
  },
};
