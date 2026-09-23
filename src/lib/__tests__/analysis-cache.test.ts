import { describe, expect, it } from "vitest";

import type { AnalysisFields } from "../analysis-runner.server";
import type { AnalysisRow, GameRow } from "../lock-lab-types";
import { ensureSimulationBatch, type BatchDeps } from "../simulation-runner.server";
import type { NewBatch, SimulationStore, StoredBatch } from "../simulation-store.server";
import { SIMULATION_ENGINE_VERSION, SIMULATION_RUNS, meaningfulInputChange, inputSnapshot } from "../simulation.server";

type Row = StoredBatch & { simulations: unknown[] };

/** In-memory stand-in for game_simulations + game_analyses with the same rules the database enforces. */
function memoryStore() {
  const batches: Row[] = [];
  const analyses = new Map<string, AnalysisRow>();
  let lock = false;
  let seq = 0;
  const clone = <T>(v: T): T => structuredClone(v);
  const store: SimulationStore = {
    async readCurrent(gameId) {
      const batch = batches.find((b) => b.game_id === gameId && b.is_current) ?? null;
      return { batch: batch ? clone(batch) : null, analysis: clone(analyses.get(gameId) ?? null) };
    },
    async findBatch(gameId, fingerprint) {
      const b = batches.find((x) => x.game_id === gameId && x.input_fingerprint === fingerprint);
      return b ? clone(b) : null;
    },
    async saveBatch(batch: NewBatch) {
      for (const b of batches) if (b.game_id === batch.game_id) b.is_current = false;
      const existing = batches.find((b) => b.game_id === batch.game_id && b.input_fingerprint === batch.input_fingerprint);
      if (existing?.analysis_snapshot) throw new Error("A stored simulation batch is immutable");
      const row: Row = {
        id: `batch-${++seq}`,
        game_id: batch.game_id,
        input_fingerprint: batch.input_fingerprint,
        engine_version: batch.engine_version,
        runs: batch.runs,
        is_current: true,
        generated_at: new Date().toISOString(),
        aggregate: clone(batch.aggregate),
        analysis_snapshot: clone(batch.analysis_snapshot),
        input_snapshot: clone(batch.input_snapshot),
        simulations: clone(batch.simulations),
      };
      batches.push(row);
      return clone(row);
    },
    async activateBatch(gameId, batchId) {
      for (const b of batches) if (b.game_id === gameId) b.is_current = b.id === batchId;
    },
    async writeAnalysis(gameId, fields, simulationId) {
      const prev = analyses.get(gameId);
      const row = {
        ...clone(fields),
        id: prev?.id ?? `analysis-${gameId}`,
        game_id: gameId,
        simulation_id: simulationId,
        top_pick_result: "pending",
        graded_at: null,
      } as AnalysisRow;
      analyses.set(gameId, row);
      return clone(row);
    },
    async claimLock() {
      if (lock) return false;
      lock = true;
      return true;
    },
    async releaseLock() {
      lock = false;
    },
  };
  return { store, batches, analyses };
}

function makeGame(overrides: Partial<{ homePrice: number; awayPrice: number; home: number; injuries: GameRow["injuries"] }> = {}): GameRow {
  const home = overrides.home ?? -7;
  return {
    id: "game-gb",
    provider_game_id: "evt",
    sport: "NFL",
    home_team: "Green Bay Packers",
    away_team: "Atlanta Falcons",
    commence_time: new Date(Date.now() + 86_400_000).toISOString(),
    status: "scheduled",
    is_demo: false,
    injuries: overrides.injuries ?? [],
    props: [],
    updated_at: new Date().toISOString(),
    odds: {
      bookmaker: "FanDuel",
      bookmakerKey: "fanduel",
      capturedAt: "2026-09-23T03:00:00Z",
      spread: { home, away: -home, homePrice: overrides.homePrice ?? -115, awayPrice: overrides.awayPrice ?? -105 },
      total: { points: 43.5, overPrice: -110, underPrice: -110 },
      moneyline: { home: -320, away: 260 },
    },
  } as unknown as GameRow;
}

/** Stand-in for the formula: posts the Packers spread at whatever price the board shows, settled in 30 of 50 games. */
function countingCompute() {
  let calls = 0;
  const compute: BatchDeps["compute"] = async (game) => {
    calls += 1;
    const spread = game.odds.spread!;
    const fields: AnalysisFields = {
      sport: game.sport,
      engine_version: "direct-v3",
      odds_snapshot: structuredClone(game.odds),
      odds_captured_at: game.odds.capturedAt ?? null,
      odds_book: game.odds.bookmaker ?? null,
      is_live_odds: true,
      generated_at: new Date().toISOString(),
      top_bets: [
        {
          key: "top1",
          rank: 1,
          badge: "green",
          label: `PACKE ${spread.home} (${spread.homePrice})`,
          market: "Spread",
          selection: "Green Bay Packers",
          line: String(spread.home),
          odds: String(spread.homePrice),
          point: spread.home,
          price: spread.homePrice,
          book: "FanDuel",
          capturedAt: game.odds.capturedAt ?? null,
          candidateKey: "spread-home",
          simRuns: 50,
          simHits: Array.from({ length: 30 }, (_, i) => i + 1),
          reason: `formula run ${calls}`,
        },
      ],
      bad_bet: null,
      fun_bets: [],
      player_props: [],
      verdict: null,
      candidate_audit: null,
    };
    return fields;
  };
  return { compute, calls: () => calls };
}

function deps(store: SimulationStore, compute: BatchDeps["compute"]): Partial<BatchDeps> {
  return { store, compute, refresh: null, sleep: async () => {}, now: () => Date.now() };
}

describe("precomputed 50-run analysis cache", () => {
  it("repeat Analyze clicks and a second user get the exact same stored card without a new batch", async () => {
    const { store, batches } = memoryStore();
    const { compute, calls } = countingCompute();
    const game = makeGame();

    const first = await ensureSimulationBatch(game, {}, deps(store, compute)); // user A
    const again = await ensureSimulationBatch(game, {}, deps(store, compute)); // user A clicks again
    const refresh = await ensureSimulationBatch(makeGame(), {}, deps(store, compute)); // page refresh
    const userB = await ensureSimulationBatch(makeGame(), {}, deps(store, compute)); // different user

    expect(calls()).toBe(1);
    expect(batches).toHaveLength(1);
    expect(first!.fromCache).toBe(false);
    for (const r of [again, refresh, userB]) {
      expect(r!.fromCache).toBe(true);
      expect(r!.batchId).toBe(first!.batchId);
      expect(r!.analysis.top_bets).toEqual(first!.analysis.top_bets);
      expect(r!.analysis.player_props).toEqual(first!.analysis.player_props);
      expect(r!.analysis.fun_bets).toEqual(first!.analysis.fun_bets);
    }
  });

  it("stores exactly 50 simulation outcomes and the pick's hit rate and edge", async () => {
    const { store, batches } = memoryStore();
    const { compute } = countingCompute();
    const res = await ensureSimulationBatch(makeGame(), {}, deps(store, compute));
    expect(batches[0]!.runs).toBe(SIMULATION_RUNS);
    expect(SIMULATION_RUNS).toBe(50);
    expect(batches[0]!.simulations).toHaveLength(50);
    expect(batches[0]!.engine_version).toBe(SIMULATION_ENGINE_VERSION);
    const pick = res!.analysis.top_bets[0]!;
    expect(pick.simHitRate).toBe(0.6);
    expect(pick.modelEdge).toBeCloseTo(0.6 - 115 / 215, 3);
    expect(res!.analysis.simulation_id).toBe(batches[0]!.id);
  });

  it("concurrent Analyze requests share one generator", async () => {
    const { store, batches } = memoryStore();
    const { compute, calls } = countingCompute();
    const game = makeGame();
    const [a, b, c] = await Promise.all([
      ensureSimulationBatch(game, {}, deps(store, compute)),
      ensureSimulationBatch(game, {}, deps(store, compute)),
      ensureSimulationBatch(game, {}, deps(store, compute)),
    ]);
    expect(calls()).toBe(1);
    expect(batches).toHaveLength(1);
    expect(b!.analysis.top_bets).toEqual(a!.analysis.top_bets);
    expect(c!.analysis.top_bets).toEqual(a!.analysis.top_bets);
  });

  it("a logged Packers -7 -115 stays -115 when the live price moves to -105", async () => {
    const { store, batches } = memoryStore();
    const { compute, calls } = countingCompute();
    const logged = await ensureSimulationBatch(makeGame({ homePrice: -115 }), {}, deps(store, compute));
    const moved = await ensureSimulationBatch(makeGame({ homePrice: -105, awayPrice: -115 }), {}, deps(store, compute));

    // -115 -> -105 is a juice wiggle, not a meaningful move: same stored card.
    expect(calls()).toBe(1);
    expect(batches).toHaveLength(1);
    expect(moved!.analysis.top_bets[0]!.label).toBe("PACKE -7 (-115)");
    expect(moved!.analysis.top_bets[0]!.price).toBe(-115);
    expect(logged!.analysis.top_bets[0]!.price).toBe(-115);
  });

  it("a meaningful market, injury or engine change creates a new 50-run batch and keeps the old one intact", async () => {
    const { store, batches } = memoryStore();
    const { compute, calls } = countingCompute();
    await ensureSimulationBatch(makeGame(), {}, deps(store, compute));
    const oldSnapshot = structuredClone(batches[0]!.analysis_snapshot);
    // A tail copies the displayed pick at the moment it is taken.
    const tailed = structuredClone(batches[0]!.analysis_snapshot!.top_bets[0]!);

    const lineMove = await ensureSimulationBatch(makeGame({ home: -7.5 }), {}, deps(store, compute));
    expect(calls()).toBe(2);
    expect(batches).toHaveLength(2);
    expect(lineMove!.fromCache).toBe(false);
    expect(lineMove!.analysis.top_bets[0]!.label).toBe("PACKE -7.5 (-115)");
    expect(batches.filter((b) => b.is_current)).toHaveLength(1);
    expect(batches[1]!.simulations).toHaveLength(50);

    const injured = await ensureSimulationBatch(
      makeGame({ home: -7.5, injuries: [{ team: "Green Bay Packers", player: "Jordan Love", status: "Out" }] }),
      {},
      deps(store, compute),
    );
    expect(calls()).toBe(3);
    expect(injured!.fromCache).toBe(false);

    // Engine version change: the stored batch was produced by an older engine.
    batches.find((b) => b.is_current)!.engine_version = "sim-old";
    await ensureSimulationBatch(
      makeGame({ home: -7.5, injuries: [{ team: "Green Bay Packers", player: "Jordan Love", status: "Out" }] }),
      {},
      deps(store, compute),
    );
    expect(calls()).toBe(4);

    // The first batch, and the bet tailed from it, never changed.
    expect(batches[0]!.analysis_snapshot).toEqual(oldSnapshot);
    expect(tailed.label).toBe("PACKE -7 (-115)");
    expect(tailed.price).toBe(-115);
  });

  it("returning to earlier inputs reuses that stored batch instead of re-running the formula", async () => {
    const { store, batches } = memoryStore();
    const { compute, calls } = countingCompute();
    const first = await ensureSimulationBatch(makeGame(), {}, deps(store, compute));
    await ensureSimulationBatch(makeGame({ home: -7.5 }), {}, deps(store, compute));
    const back = await ensureSimulationBatch(makeGame(), {}, deps(store, compute));
    expect(calls()).toBe(2);
    expect(batches).toHaveLength(2);
    expect(back!.batchId).toBe(first!.batchId);
    expect(back!.analysis.top_bets).toEqual(first!.analysis.top_bets);
  });
});

describe("meaningful input changes", () => {
  const base = inputSnapshot(makeGame());
  it("ignores juice wiggles and non-material injury tags", () => {
    expect(meaningfulInputChange(base, inputSnapshot(makeGame({ homePrice: -105, awayPrice: -115 })))).toBeNull();
    expect(
      meaningfulInputChange(
        base,
        inputSnapshot(makeGame({ injuries: [{ team: "Green Bay Packers", player: "X", status: "Questionable" }] })),
      ),
    ).toBeNull();
  });
  it("flags line moves, big price moves and material injuries", () => {
    expect(meaningfulInputChange(base, inputSnapshot(makeGame({ home: -6.5 })))).toBe("spread moved");
    expect(meaningfulInputChange(base, inputSnapshot(makeGame({ homePrice: -135 })))).toBe("spread price moved");
    expect(
      meaningfulInputChange(
        base,
        inputSnapshot(makeGame({ injuries: [{ team: "Green Bay Packers", player: "X", status: "Out" }] })),
      ),
    ).toBe("material injury change");
  });
});
