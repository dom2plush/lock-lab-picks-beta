/**
 * Precomputed Lock Lab batches.
 *
 * The expensive part of the formula (the handicap read) runs ONCE per set of
 * inputs. Its finished board is then settled 50 times deterministically and
 * both the analysis and the 50 runs are stored, so Analyze never pays for a
 * new run and every user sees the same numbers.
 */
import { buildLiveAnalysis, verifiedExtras } from "./analysis-runner.server";
import type { AnalysisRow, GameRow } from "./lock-lab-types";
import {
  SIMULATION_ENGINE_VERSION,
  SIMULATION_RUNS,
  inputFingerprint,
  picksToSimulate,
  runSimulations,
  type SimulationAggregate,
} from "./simulation.server";

export type SimulationBatch = {
  analysis: AnalysisRow;
  aggregate: SimulationAggregate | null;
  fingerprint: string;
  fromCache: boolean;
};

type StoredBatch = {
  id: string;
  input_fingerprint: string;
  engine_version: string;
  aggregate: SimulationAggregate | null;
};

async function readStored(gameId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [batch, analysis] = await Promise.all([
    supabaseAdmin
      .from("game_simulations")
      .select("id, input_fingerprint, engine_version, aggregate")
      .eq("game_id", gameId)
      .maybeSingle(),
    supabaseAdmin.from("game_analyses").select("*").eq("game_id", gameId).maybeSingle(),
  ]);
  return {
    batch: (batch.data as unknown as StoredBatch | null) ?? null,
    analysis: (analysis.data as unknown as AnalysisRow | null) ?? null,
  };
}

/**
 * Returns the stored batch for a game, generating it only when there is none
 * or when a meaningful input (line, injury, QB status) has moved.
 */
export async function ensureSimulationBatch(
  game: GameRow,
  options: { force?: boolean; allowGenerate?: boolean } = {},
): Promise<SimulationBatch | null> {
  const { force = false, allowGenerate = true } = options;
  const fingerprint = inputFingerprint(game);
  const stored = await readStored(game.id);

  const fresh =
    !force &&
    stored.batch != null &&
    stored.analysis != null &&
    stored.batch.input_fingerprint === fingerprint &&
    stored.batch.engine_version === SIMULATION_ENGINE_VERSION;

  if (fresh) {
    return {
      analysis: stored.analysis!,
      aggregate: stored.batch!.aggregate ?? null,
      fingerprint,
      fromCache: true,
    };
  }

  if (!allowGenerate) {
    return stored.analysis
      ? {
          analysis: stored.analysis,
          aggregate: stored.batch?.aggregate ?? null,
          fingerprint,
          fromCache: true,
        }
      : null;
  }

  return generateBatch(game, fingerprint, stored.analysis);
}

/** One handicap read + 50 deterministic settlements, persisted together. */
export async function generateBatch(
  game: GameRow,
  fingerprint: string,
  previous: AnalysisRow | null,
): Promise<SimulationBatch> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // A batch is only generated when inputs moved, so pull the current board
  // (standard lines, alternate ladders, player props, injuries) first.
  const { refreshGameOdds } = await import("./ingest.server");
  const current = (await refreshGameOdds(game)) ?? game;
  const currentFingerprint = inputFingerprint(current);
  const analysis = await buildLiveAnalysis(current, verifiedExtras(current), previous);
  const { simulations, aggregate } = runSimulations(
    currentFingerprint,
    picksToSimulate(analysis),
    SIMULATION_RUNS,
  );

  const saved = await supabaseAdmin
    .from("game_simulations")
    .upsert(
      {
        game_id: game.id,
        analysis_id: analysis.id,
        sport: game.sport,
        input_fingerprint: fingerprint,
        engine_version: SIMULATION_ENGINE_VERSION,
        runs: SIMULATION_RUNS,
        generated_at: new Date().toISOString(),
        simulations: simulations as unknown as never,
        aggregate: aggregate as unknown as never,
      } as never,
      { onConflict: "game_id" },
    )
    .select("id")
    .maybeSingle();

  if (saved.error) console.error("simulation batch save failed", game.id, saved.error.message);

  return { analysis, aggregate, fingerprint, fromCache: false };
}

/**
 * Backend precompute pass. Bounded per run, skips games whose inputs have not
 * moved, and stops early on an AI credit/policy block so a scheduled job can
 * never burn credits in a loop.
 */
export async function precomputeUpcoming(
  sport: "NFL" | "CFB" | null,
  limit = 12,
): Promise<{ considered: number; generated: number; cached: number; errors: string[] }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const horizon = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
  let query = supabaseAdmin
    .from("games")
    .select("*")
    .eq("status", "scheduled")
    .eq("is_demo", false)
    .gte("commence_time", new Date().toISOString())
    .lte("commence_time", horizon)
    .order("commence_time", { ascending: true })
    .limit(limit);
  if (sport) query = query.eq("sport", sport);

  const { data, error } = await query;
  if (error) return { considered: 0, generated: 0, cached: 0, errors: [error.message] };

  const games = (data ?? []) as unknown as GameRow[];
  const report = { considered: games.length, generated: 0, cached: 0, errors: [] as string[] };

  for (const game of games) {
    try {
      const batch = await ensureSimulationBatch(game);
      if (!batch) continue;
      if (batch.fromCache) report.cached += 1;
      else report.generated += 1;
    } catch (err) {
      const message = (err as Error).message;
      report.errors.push(`${game.away_team} at ${game.home_team}: ${message}`);
      // Credit / policy / rate blocks halt the whole pass instead of retrying.
      if (/\b(402|403|429)\b/.test(message)) break;
    }
  }

  return report;
}
