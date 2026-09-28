/**
 * Precomputed Lock Lab batches.
 *
 * The formula (including the handicap read) runs ONCE per meaningful set of
 * inputs. Its finished card is settled against exactly 100 simulated games and
 * the card, the 100 runs and the inputs they came from are stored together as a
 * permanent batch. Analyze reads the current batch; every user sees the same
 * card until a meaningful input (line, juice, material injury, sportsbook,
 * engine version) actually changes. Older batches are never overwritten.
 */
import {
  computeLiveAnalysis,
  verifiedExtras,
  type AnalysisFields,
} from "./analysis-runner.server";
import { firstTdReason, publicSideSignal, sportsbookSideSignal } from "./analysis-engine.server";
import type { AnalysisRow, GameOdds, GameRow, PublicBetting } from "./lock-lab-types";
import {
  SIMULATION_ENGINE_VERSION,
  STORED_BATCH_VERSION,
  SIMULATION_RUNS,
  americanToProbability,
  inputFingerprint,
  inputSnapshot,
  meaningfulInputChange,
  picksToSimulate,
  runSimulations,
  simulationSeedKey,
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
 * exactly 100 runs, is the batch the displayed card came from, and no
 * meaningful input has moved since it was generated.
 */
export function batchIsReusable(
  batch: StoredBatch | null,
  analysis: AnalysisRow | null,
  inputs: InputSnapshot,
): boolean {
  if (!batch || !analysis) return false;
  if (batch.engine_version !== STORED_BATCH_VERSION) return false;
  if (batch.runs !== SIMULATION_RUNS) return false;
  if (!batch.analysis_snapshot) return false;
  if (analysis.simulation_id !== batch.id) return false;
  return meaningfulInputChange(batch.input_snapshot, inputs) == null;
}

function cached(batch: StoredBatch, analysis: AnalysisRow, fingerprint: string): SimulationBatch {
  return { analysis, aggregate: batch.aggregate ?? null, fingerprint, fromCache: true, batchId: batch.id };
}

/**
 * Returns the stored batch for a game. A new 100-run batch is generated only
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
 * Replaces every pick's write-up with the numbers the 100 runs actually
 * produced, and stamps the simulated hit rate and model edge onto the pick so
 * they are stored with it permanently.
 */
export type BadgeMarketContext = {
  publicBetting: PublicBetting | null | undefined;
  odds: GameOdds | null | undefined;
  previousOdds: GameOdds | null | undefined;
};

/** Opposite side must hold at least this share of public tickets/money. */
const HEAVY_OPPOSITE_SHARE = 65;

/**
 * Slightly negative edges still count as simulation support: a bet whose
 * simulated hit rate lands within this many points of its price is "thin but
 * supported" and may earn the market-signal badge upgrade. Clearly negative
 * edges beyond this tolerance are never upgraded.
 */
const SUPPORT_EDGE_TOLERANCE = 0.02;

/**
 * Badge-only adjustment from public betting splits for a Top 2 bet with a
 * thin/close edge. Never changes which bets were selected; a bet already green
 * (strong edge) is left alone. Needs the simulation to support the bet (hit
 * rate at or within a couple of points of the price — a slightly negative
 * model edge no longer blocks the upgrade) and heavy public concentration on
 * the other side; red becomes yellow, and yellow becomes green when the
 * combined public splits and the available odds/juice/line-movement evidence
 * point toward this side as the sportsbook-favourable outcome — no single odds
 * signal (such as line movement) is required to agree on its own.
 */
export function applySplitBadge<P extends { badge?: string; reason: string; modelEdge?: number | null; sideKey?: string | null }>(
  bet: P,
  market: BadgeMarketContext | undefined,
): P {
  if (!market?.publicBetting || !bet.sideKey) return bet;
  if (bet.badge === "green") return bet;
  if (bet.modelEdge == null || bet.modelEdge < -SUPPORT_EDGE_TOLERANCE) return bet;
  const signal = publicSideSignal(bet.sideKey, market.publicBetting);
  // signal +1 ⇔ own share 25%; opposite share = 50 + 25·signal.
  if (signal == null || 50 + 25 * signal < HEAVY_OPPOSITE_SHARE) return bet;
  let badge = bet.badge === "red" ? "yellow" : bet.badge ?? "yellow";
  // The public splits count toward the sportsbook-favourable read alongside
  // the odds evidence (juice, line movement); no single signal must agree alone.
  const bookSide = sportsbookSideSignal(
    { key: bet.sideKey, standardKey: bet.sideKey, group: "core" } as never,
    market.odds,
    market.previousOdds,
    market.publicBetting,
  );
  const favourable = bookSide > 0;
  if (badge === "yellow" && favourable) badge = "green";
  if (badge === bet.badge) return bet;
  const note = favourable
    ? " Public money is heavily on the other side and the market reads this as the sportsbook-favourable outcome — confidence raised."
    : " Public money is heavily on the other side — confidence raised.";
  return { ...bet, badge, reason: `${bet.reason}${note}` };
}

export function withSimulatedReasons<T extends Pick<AnalysisFields, "top_bets" | "player_props" | "fun_bets">>(
  analysis: T,
  aggregate: SimulationAggregate,
  market?: BadgeMarketContext,
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
    { fun = false }: { fun?: boolean; top?: boolean } = {},
  ): P => {
    const simulated = byKey.get(pick.key);
    if (!simulated) return pick;
    // First TD scorers: the simulated count only — no price, edge or status read.
    if ((pick as { market?: string }).market === "First TD scorer") {
      return {
        ...pick,
        simHitRate: Math.round(simulated.hitRate * 10000) / 10000,
        modelEdge: null,
        expectedRoi: null,
        reason: firstTdReason(simulated.wins, aggregate.runs),
      } as P;
    }
    const implied = americanToProbability(pick.odds ?? null);
    const edge = implied != null ? simulated.hitRate - implied : null;
    // Expected return per unit staked at the exact posted price — the number
    // the board ranks on. A +160 price and a -110 price cannot be compared on
    // percentage-point edge alone, so that stays a secondary read.
    const priceNumber = Number(String(pick.odds ?? "").replace("+", ""));
    const roi =
      Number.isFinite(priceNumber) && priceNumber !== 0
        ? simulated.hitRate * ((priceNumber > 0 ? priceNumber / 100 : 100 / Math.abs(priceNumber)) + 1) - 1
        : null;
    const parts = [
      `Simulated hit rate ${pct(simulated.hitRate)} (${simulated.wins} of ${aggregate.runs} Lock Lab runs)`,
    ];
    if (roi != null) {
      parts.push(`${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(1)}% expected return at this price`);
    }
    if (implied != null && edge != null) {
      parts.push(
        `price implies ${pct(implied)}`,
        `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}% edge`,
      );
    }
    // Honest labelling: a non-positive edge is never described as value. Top 2
    // bets are ranked on simulated frequency, so no slot is called a fallback.
    const valueNote =
      edge == null
        ? ""
        : edge <= 0
          ? " No positive value at this price — the simulation ranks it here on how often it wins, not on price value."
          : edge < 0.01
            ? " Thin edge — weak value."
            : "";
    // Legacy support for old stored fun bets; new analyses keep that field empty.
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
      expectedRoi: roi == null ? null : Math.round(roi * 10000) / 10000,
      reason: `${parts.join(" · ")}.${valueNote}`,
    } as P;
  };

  const topBets = (analysis.top_bets ?? [])
    .map((bet) => describe(bet, { top: true }))
    .map((bet) => applySplitBadge(bet, market))
    .map((bet, index) => ({ ...bet, key: `top${index + 1}`, rank: index + 1 }));
  // Touchdown picks keep their own keys so the stored card, the tail record and
  // the touchdown section always refer to the same bet.
  let propIndex = 0;
  const props = (analysis.player_props ?? [])
    .map((prop) => describe(prop))
    .map((prop) =>
      String(prop.key).startsWith("td-")
        ? prop
        : { ...prop, key: `prop-${(propIndex += 1)}` },
    );

  return {
    ...analysis,
    top_bets: topBets,
    player_props: props,
    fun_bets: [],
  };
}

function isStale(game: GameRow, now: number): boolean {
  const stamp = game.updated_at ?? game.props_updated_at ?? game.odds_updated_at ?? null;
  if (!stamp) return true;
  return now - new Date(stamp).getTime() > ODDS_REFRESH_TTL_MS;
}

/** One formula run + exactly 100 simulated settlements, stored as a new permanent batch. */
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
    existing.engine_version === STORED_BATCH_VERSION &&
    existing.runs === SIMULATION_RUNS
  ) {
    await d.store.activateBatch(current.id, existing.id);
    const analysis = await d.store.writeAnalysis(current.id, existing.analysis_snapshot, existing.id);
    return { analysis, aggregate: existing.aggregate, fingerprint, fromCache: true, batchId: existing.id };
  }

  const fields = await d.compute(current, verifiedExtras(current), stored.analysis?.odds_snapshot ?? null);
  // Settlement uses the same game + model-version seed as the score and player
  // models, so identical inputs always settle to identical outcomes.
  const { simulations, aggregate } = runSimulations(
    simulationSeedKey(current),
    picksToSimulate(fields),
    SIMULATION_RUNS,
  );
  if (simulations.length !== SIMULATION_RUNS) throw new Error("A Lock Lab batch must hold exactly 50 simulations");
  const described = withSimulatedReasons(fields, aggregate, {
    publicBetting: current.public_betting ?? null,
    odds: current.odds ?? null,
    previousOdds: stored.analysis?.odds_snapshot ?? null,
  });

  // Stored batches are immutable: a forced/engine-mismatched rerun of the same
  // inputs is stored as its own row rather than overwriting the old one.
  const storageFingerprint = existing?.analysis_snapshot ? `${fingerprint}~${d.now().toString(36)}` : fingerprint;
  const saved = await d.store.saveBatch({
    game_id: current.id,
    sport: current.sport,
    input_fingerprint: storageFingerprint,
    engine_version: STORED_BATCH_VERSION,
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
      const { attachPublicBetting } = await import("./public-betting.server");
      const batch = await ensureSimulationBatch(await attachPublicBetting(game));
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
