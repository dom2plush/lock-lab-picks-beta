/**
 * Precomputed Lock Lab batches.
 *
 * The formula (including the handicap read) runs ONCE per meaningful set of
 * inputs. Its finished card is settled against exactly 50 simulated games and
 * the card, the 50 runs and the inputs they came from are stored together as a
 * permanent batch. Analyze reads the current batch; every user sees the same
 * card until a meaningful input (line, juice, material injury, sportsbook,
 * engine version) actually changes. Older batches are never overwritten.
 */
import {
  computeLiveAnalysis,
  verifiedExtras,
  type AnalysisFields,
} from "./analysis-runner.server";
import type { AnalysisRow, GameRow } from "./lock-lab-types";
import {
  SIMULATION_ENGINE_VERSION,
  SIMULATION_RUNS,
  americanToProbability,
  inputFingerprint,
  inputSnapshot,
  meaningfulInputChange,
  picksToSimulate,
  runSimulations,
  type InputSnapshot,
  type SimulationAggregate,
} from "./simulation.server";
import { supabaseSimulationStore, type SimulationStore, type StoredBatch } from "./simulation-store.server";

export type SimulationBatch = {
  analysis: AnalysisRow;
  aggregate: SimulationAggregate | null;
  fingerprint: string;
  fromCache: boolean;
  batchId: string | null;
};

/** Odds older than this are re-pulled before a new batch is generated. */
export const ODDS_REFRESH_TTL_MS = 10 * 60 * 1000;
/** How long one generator may hold a game before another may take over. */
const LOCK_SECONDS = 120;
const WAIT_STEP_MS = 1500;
const WAIT_LIMIT_MS = 60_000;

export type BatchDeps = {
  store: SimulationStore;
  compute: typeof computeLiveAnalysis;
  refresh: ((game: GameRow) => Promise<GameRow | null>) | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

async function defaultRefresh(game: GameRow) {
  const { refreshGameOdds } = await import("./ingest.server");
  return refreshGameOdds(game);
}

const defaultDeps: BatchDeps = {
  store: supabaseSimulationStore,
  compute: computeLiveAnalysis,
  refresh: defaultRefresh,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * A stored batch stands when it was produced by this engine version, holds
 * exactly 50 runs, is the batch the displayed card came from, and no
 * meaningful input has moved since it was generated.
 */
export function batchIsReusable(
  batch: StoredBatch | null,
  analysis: AnalysisRow | null,
  inputs: InputSnapshot,
): boolean {
  if (!batch || !analysis) return false;
  if (batch.engine_version !== SIMULATION_ENGINE_VERSION) return false;
  if (batch.runs !== SIMULATION_RUNS) return false;
  if (!batch.analysis_snapshot) return false;
  if (analysis.simulation_id !== batch.id) return false;
  return meaningfulInputChange(batch.input_snapshot, inputs) == null;
}

function cached(batch: StoredBatch, analysis: AnalysisRow, fingerprint: string): SimulationBatch {
  return { analysis, aggregate: batch.aggregate ?? null, fingerprint, fromCache: true, batchId: batch.id };
}

/**
 * Returns the stored batch for a game. A new 50-run batch is generated only
 * when none exists or a meaningful input changed — never because another user,
 * a refresh or a repeat click asked for it. Concurrent requests share one
 * generator; the others wait for its stored result.
 */
export async function ensureSimulationBatch(
  game: GameRow,
  options: { force?: boolean; allowGenerate?: boolean } = {},
  deps: Partial<BatchDeps> = {},
): Promise<SimulationBatch | null> {
  const d: BatchDeps = { ...defaultDeps, ...deps };
  const { force = false, allowGenerate = true } = options;
  const inputs = inputSnapshot(game);
  const fingerprint = inputFingerprint(game);
  const stored = await d.store.readCurrent(game.id);

  if (!force && batchIsReusable(stored.batch, stored.analysis, inputs)) {
    return cached(stored.batch!, stored.analysis!, fingerprint);
  }

  if (!allowGenerate) {
    return stored.analysis
      ? {
          analysis: stored.analysis,
          aggregate: stored.batch?.aggregate ?? null,
          fingerprint,
          fromCache: true,
          batchId: stored.batch?.id ?? null,
        }
      : null;
  }

  const claimed = await d.store.claimLock(game.id, LOCK_SECONDS);
  if (!claimed) {
    // Another request is generating this game's batch: wait for its stored card.
    const started = d.now();
    while (d.now() - started < WAIT_LIMIT_MS) {
      await d.sleep(WAIT_STEP_MS);
      const next = await d.store.readCurrent(game.id);
      if (next.batch && next.analysis && next.batch.id !== stored.batch?.id && next.analysis.simulation_id === next.batch.id) {
        return cached(next.batch, next.analysis, fingerprint);
      }
    }
    const last = await d.store.readCurrent(game.id);
    return last.analysis
      ? {
          analysis: last.analysis,
          aggregate: last.batch?.aggregate ?? null,
          fingerprint,
          fromCache: true,
          batchId: last.batch?.id ?? null,
        }
      : null;
  }

  try {
    // Re-check after taking the lock: a generator that just finished wins.
    const again = await d.store.readCurrent(game.id);
    if (!force && batchIsReusable(again.batch, again.analysis, inputs)) {
      return cached(again.batch!, again.analysis!, fingerprint);
    }
    return await generateBatch(game, again, d, force);
  } finally {
    await d.store.releaseLock(game.id);
  }
}

/**
 * Replaces every pick's write-up with the numbers the 50 runs actually
 * produced, and stamps the simulated hit rate and model edge onto the pick so
 * they are stored with it permanently.
 */
export function withSimulatedReasons<T extends Pick<AnalysisFields, "top_bets" | "player_props" | "fun_bets">>(
  analysis: T,
  aggregate: SimulationAggregate,
): T {
  const byKey = new Map(aggregate.picks.map((pick) => [pick.key, pick]));
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  /**
   * Same thresholds the engine ranks on, applied to the published light so a
   * bet cannot read as a pass in one section and playable in another:
   * 1%+ simulated edge is green, 0.5%+ is yellow, anything less is red.
   */
  const badgeFor = (edge: number | null, fallback: string): string => {
    if (edge == null) return fallback;
    if (edge >= 0.01) return "green";
    return edge >= 0.005 ? "yellow" : "red";
  };

  const describe = <P extends { key: string; odds?: string | null; reason: string; badge?: string }>(
    pick: P,
    { fun = false }: { fun?: boolean } = {},
  ): P => {
    const simulated = byKey.get(pick.key);
    if (!simulated) return pick;
    const implied = americanToProbability(pick.odds ?? null);
    const edge = implied != null ? simulated.hitRate - implied : null;
    const parts = [
      `Simulated hit rate ${pct(simulated.hitRate)} (${simulated.wins} of ${aggregate.runs} Lock Lab runs)`,
    ];
    if (implied != null && edge != null) {
      parts.push(
        `price implies ${pct(implied)}`,
        `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}% edge`,
      );
    }
    // The fun bet is a long shot by design, so it is never promoted to green
    // on a thin edge, but it is not marked red for being a long shot either.
    const badge = fun
      ? edge != null && edge >= 0.01
        ? "green"
        : "yellow"
      : badgeFor(edge, pick.badge ?? "yellow");
    return {
      ...pick,
      badge,
      simHitRate: Math.round(simulated.hitRate * 10000) / 10000,
      modelEdge: edge == null ? null : Math.round(edge * 10000) / 10000,
      reason: `${parts.join(" · ")}.`,
    } as P;
  };

  const topBets = (analysis.top_bets ?? [])
    .map((bet) => describe(bet))
    .map((bet, index) => ({ ...bet, key: `top${index + 1}`, rank: index + 1 }));
  const props = (analysis.player_props ?? [])
    .map((prop) => describe(prop))
    .map((prop, index) => ({ ...prop, key: `prop-${index + 1}` }));

  return {
    ...analysis,
    top_bets: topBets,
    player_props: props,
    fun_bets: (analysis.fun_bets ?? []).map((bet) => describe(bet, { fun: true })),
  };
}

function isStale(game: GameRow, now: number): boolean {
  const stamp = game.updated_at ?? game.props_updated_at ?? game.odds_updated_at ?? null;
  if (!stamp) return true;
  return now - new Date(stamp).getTime() > ODDS_REFRESH_TTL_MS;
}

/** One formula run + exactly 50 simulated settlements, stored as a new permanent batch. */
export async function generateBatch(
  game: GameRow,
  stored: { batch: StoredBatch | null; analysis: AnalysisRow | null },
  deps: Partial<BatchDeps> = {},
  force = false,
): Promise<SimulationBatch> {
  const d: BatchDeps = { ...defaultDeps, ...deps };
  let current = game;
  if (d.refresh && isStale(game, d.now())) current = (await d.refresh(game)) ?? game;

  const inputs = inputSnapshot(current);
  const fingerprint = inputFingerprint(current);

  // The refreshed board may show the move was noise after all.
  if (!force && batchIsReusable(stored.batch, stored.analysis, inputs)) {
    return cached(stored.batch!, stored.analysis!, fingerprint);
  }

  // Inputs returned to a state an earlier batch already answered: reuse that
  // exact stored card instead of running the formula again.
  const existing = await d.store.findBatch(current.id, fingerprint);
  if (
    !force &&
    existing?.analysis_snapshot &&
    existing.engine_version === SIMULATION_ENGINE_VERSION &&
    existing.runs === SIMULATION_RUNS
  ) {
    await d.store.activateBatch(current.id, existing.id);
    const analysis = await d.store.writeAnalysis(current.id, existing.analysis_snapshot, existing.id);
    return { analysis, aggregate: existing.aggregate, fingerprint, fromCache: true, batchId: existing.id };
  }

  const fields = await d.compute(current, verifiedExtras(current), stored.analysis?.odds_snapshot ?? null);
  const { simulations, aggregate } = runSimulations(fingerprint, picksToSimulate(fields), SIMULATION_RUNS);
  if (simulations.length !== SIMULATION_RUNS) throw new Error("A Lock Lab batch must hold exactly 50 simulations");
  const described = withSimulatedReasons(fields, aggregate);

  // Stored batches are immutable: a forced/engine-mismatched rerun of the same
  // inputs is stored as its own row rather than overwriting the old one.
  const storageFingerprint = existing?.analysis_snapshot ? `${fingerprint}~${d.now().toString(36)}` : fingerprint;
  const saved = await d.store.saveBatch({
    game_id: current.id,
    sport: current.sport,
    input_fingerprint: storageFingerprint,
    engine_version: SIMULATION_ENGINE_VERSION,
    runs: SIMULATION_RUNS,
    simulations,
    aggregate,
    analysis_snapshot: described,
    input_snapshot: inputs,
  });
  const analysis = await d.store.writeAnalysis(current.id, described, saved.id);
  return { analysis, aggregate, fingerprint, fromCache: false, batchId: saved.id };
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
