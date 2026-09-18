/**
 * Lock Lab simulation batches.
 *
 * The Lock Lab formula (market read + one handicap pass) runs ONCE per input
 * state. Its output is then executed 50 times as independent, deterministic
 * game simulations: each run draws a margin and a total from the distribution
 * implied by the exact posted market plus Lock Lab's own probability estimate,
 * and every published selection is settled against that simulated final score.
 *
 * Rules:
 *  - 50 simulations are 50 executions of the formula's settlement math, NOT 50
 *    AI prompts. Exactly one model call is made per batch.
 *  - The batch is keyed by a fingerprint of the real inputs (lines, prices,
 *    alternate board, injuries, kickoff). Same inputs = same stored batch, so a
 *    user clicking Analyze never re-runs anything.
 *  - A material input change (line movement, new injury, new alternate board)
 *    changes the fingerprint and earns a fresh batch for that game only.
 *  - Seeded by the fingerprint, so every user sees the identical aggregate.
 */
import type { GameOdds, GameRow, PickBet } from "./lock-lab-types";
import type { EngineOutput, ExtraOffers } from "./analysis-engine.server";

export const SIMULATION_RUNS = 50;
export const SIMULATION_ENGINE_VERSION = "sim-v1";

export type SimOutcome = {
  index: number;
  homeScore: number;
  awayScore: number;
  margin: number;
  total: number;
};

export type SimSelection = {
  key: string;
  label: string;
  market: string;
  line: string | null;
  price: number | null;
  section: "top" | "bad-bet" | "opposite" | "better-number" | "fun";
  /** Share of the 50 simulations this selection cashed. Null = not simulatable. */
  simulatedProb: number | null;
  wins: number;
  losses: number;
  pushes: number;
};

export type SimAggregate = {
  runs: number;
  homeWinRate: number;
  avgMargin: number;
  medianMargin: number;
  avgTotal: number;
  projection: { homeMargin: number; total: number; marginSd: number; totalSd: number };
  selections: SimSelection[];
};

export type SimulationBatch = {
  fingerprint: string;
  engineVersion: string;
  generatedAt: string;
  simulations: SimOutcome[];
  aggregate: SimAggregate;
};

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
function probit(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  if (clamped < pLow) {
    const q = Math.sqrt(-2 * Math.log(clamped));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (clamped > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - clamped));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = clamped - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function normalDraw(rand: () => number, mean: number, sd: number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

const SPREAD_SD = { NFL: 13.2, CFB: 16.2 } as const;
const TOTAL_SD = { NFL: 10.2, CFB: 13.0 } as const;

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

/**
 * Stable signature of everything the formula actually reads. Timestamps are
 * deliberately excluded: a re-pull that returns identical lines must NOT create
 * a duplicate batch, while real line movement or injury news must.
 */
export function simulationFingerprint(
  game: Pick<GameRow, "id" | "commence_time" | "injuries" | "status">,
  odds: GameOdds,
  extra: ExtraOffers,
): string {
  const payload = {
    game: game.id,
    kickoff: game.commence_time,
    status: game.status,
    book: odds.bookmaker ?? null,
    spread: odds.spread ?? null,
    total: odds.total ?? null,
    moneyline: odds.moneyline ?? null,
    injuries: (game.injuries ?? []).map((i) => `${i.player}|${i.status}`).sort(),
    alternates: extra.alternates
      .map((o) => `${o.market}|${o.selection}|${o.point ?? ""}|${o.price}|${o.book ?? ""}`)
      .sort(),
    props: extra.props
      .map((o) => `${o.market}|${o.player ?? ""}|${o.selection}|${o.point ?? ""}|${o.price}`)
      .sort(),
    version: SIMULATION_ENGINE_VERSION,
  };
  return fnv1a(JSON.stringify(payload)).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// settlement of one selection against one simulated score
// ---------------------------------------------------------------------------

type Settleable = {
  key: string;
  label: string;
  market: string;
  line: string | null;
  price: number | null;
  selection: string;
  point: number | null;
  section: SimSelection["section"];
};

function settle(
  bet: Settleable,
  game: Pick<GameRow, "home_team" | "away_team" | "home_team_short" | "away_team_short">,
  sim: SimOutcome,
): "win" | "loss" | "push" | null {
  const market = bet.market.toLowerCase();
  const selection = bet.selection.trim().toLowerCase();
  const isHome =
    selection === game.home_team.toLowerCase() ||
    selection === (game.home_team_short ?? "").toLowerCase();
  const isAway =
    selection === game.away_team.toLowerCase() ||
    selection === (game.away_team_short ?? "").toLowerCase();

  if (market.includes("spread")) {
    if (!isHome && !isAway) return null;
    const line = bet.point ?? Number.parseFloat(bet.line ?? "");
    if (!Number.isFinite(line)) return null;
    const value = (isHome ? sim.margin : -sim.margin) + line;
    if (value === 0) return "push";
    return value > 0 ? "win" : "loss";
  }

  if (market.includes("total") && !market.includes("team")) {
    const line = bet.point ?? Number.parseFloat(bet.line ?? "");
    if (!Number.isFinite(line)) return null;
    if (sim.total === line) return "push";
    if (selection === "over") return sim.total > line ? "win" : "loss";
    if (selection === "under") return sim.total < line ? "win" : "loss";
    return null;
  }

  if (market.includes("moneyline")) {
    if (!isHome && !isAway) return null;
    if (sim.margin === 0) return "push";
    return (isHome ? sim.margin > 0 : sim.margin < 0) ? "win" : "loss";
  }

  // Team totals and player props are not settled by a game-level score model.
  return null;
}

function toSettleable(output: EngineOutput): Settleable[] {
  const out: Settleable[] = [];
  for (const bet of output.topBets) {
    out.push({
      key: bet.key,
      label: bet.label,
      market: bet.market,
      line: bet.line ?? null,
      price: bet.price ?? null,
      selection: bet.selection,
      point: bet.point ?? null,
      section: "top",
    });
  }
  const bad = output.badBet;
  if (bad) {
    out.push({
      key: `${bad.key}-bad`,
      label: bad.label,
      market: bad.market ?? "",
      line: bad.point != null ? String(bad.point) : null,
      price: bad.price ?? null,
      selection: sideFromLabel(bad.label),
      point: bad.point ?? null,
      section: "bad-bet",
    });
    if (bad.oppositeLabel && bad.oppositeLabel !== "NO VALID BAD-BET FLIP") {
      out.push({
        key: `${bad.key}-opposite`,
        label: bad.oppositeLabel,
        market: bad.oppositeMarket ?? bad.market ?? "",
        line: bad.oppositePoint != null ? String(bad.oppositePoint) : null,
        price: bad.oppositePrice ?? null,
        selection: sideFromLabel(bad.oppositeLabel),
        point: bad.oppositePoint ?? null,
        section: "opposite",
      });
    }
    if (bad.alternateLabel) {
      out.push({
        key: `${bad.key}-alternate`,
        label: bad.alternateLabel,
        market: bad.market ?? "",
        line: bad.alternatePoint != null ? String(bad.alternatePoint) : null,
        price: bad.alternatePrice ?? null,
        selection: sideFromLabel(bad.alternateLabel),
        point: bad.alternatePoint ?? null,
        section: "better-number",
      });
    }
  }
  return out;
}

/** "Broncos +3.5" / "Over 44.5" -> the side token used for settlement. */
function sideFromLabel(label: string): string {
  return label.replace(/\s*[+-]?\d+(\.\d+)?\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// the batch
// ---------------------------------------------------------------------------

/** Mean margin/total for the simulation, market first, Lock Lab estimate second. */
function projection(game: GameRow, odds: GameOdds, output: EngineOutput) {
  const sport = game.sport === "CFB" ? "CFB" : "NFL";
  const marginSd = SPREAD_SD[sport];
  const totalSd = TOTAL_SD[sport];
  const entries = output.candidateAudit?.entries ?? [];

  const spreadPoint = odds.spread?.homePoint ?? null;
  let homeMargin = spreadPoint != null ? -spreadPoint : 0;
  const spreadHome = entries.find((e) => e.key === "spread-home");
  if (spreadPoint != null && spreadHome?.estimatedProb != null) {
    // P(home covers) = Phi((mean + line) / sd)  ->  mean = sd * z - line
    const implied = marginSd * probit(spreadHome.estimatedProb) - spreadPoint;
    // The matchup read may move the market number, but only within a bounded range.
    const shift = Math.max(-3, Math.min(3, implied - homeMargin));
    homeMargin += shift;
  }

  const totalPoint = odds.total?.point ?? null;
  let total = totalPoint ?? 44;
  const over = entries.find((e) => e.key === "total-over");
  if (totalPoint != null && over?.estimatedProb != null) {
    const implied = totalPoint + totalSd * probit(over.estimatedProb);
    const shift = Math.max(-3, Math.min(3, implied - total));
    total += shift;
  }

  return { homeMargin, total, marginSd, totalSd };
}

/** Execute the stored formula output as 50 deterministic game simulations. */
export function simulateBoard(
  game: GameRow,
  odds: GameOdds,
  output: EngineOutput,
  fingerprint: string,
  runs = SIMULATION_RUNS,
): SimulationBatch {
  const proj = projection(game, odds, output);
  const rand = mulberry32(fnv1a(`${game.id}:${fingerprint}`));

  const simulations: SimOutcome[] = [];
  for (let index = 0; index < runs; index += 1) {
    const margin = normalDraw(rand, proj.homeMargin, proj.marginSd);
    const total = Math.max(0, normalDraw(rand, proj.total, proj.totalSd));
    const homeScore = Math.max(0, Math.round((total + margin) / 2));
    const awayScore = Math.max(0, Math.round((total - margin) / 2));
    simulations.push({
      index: index + 1,
      homeScore,
      awayScore,
      margin: homeScore - awayScore,
      total: homeScore + awayScore,
    });
  }

  const selections: SimSelection[] = toSettleable(output).map((bet) => {
    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let simulatable = false;
    for (const sim of simulations) {
      const result = settle(bet, game, sim);
      if (result == null) continue;
      simulatable = true;
      if (result === "win") wins += 1;
      else if (result === "loss") losses += 1;
      else pushes += 1;
    }
    const decided = wins + losses;
    return {
      key: bet.key,
      label: bet.label,
      market: bet.market,
      line: bet.line,
      price: bet.price,
      section: bet.section,
      simulatedProb: simulatable && decided > 0 ? wins / decided : null,
      wins,
      losses,
      pushes,
    };
  });

  const margins = simulations.map((s) => s.margin).sort((a, b) => a - b);
  const mid = Math.floor(margins.length / 2);
  const aggregate: SimAggregate = {
    runs: simulations.length,
    homeWinRate: simulations.filter((s) => s.margin > 0).length / (simulations.length || 1),
    avgMargin: simulations.reduce((sum, s) => sum + s.margin, 0) / (simulations.length || 1),
    medianMargin: margins.length ? (margins[mid] ?? 0) : 0,
    avgTotal: simulations.reduce((sum, s) => sum + s.total, 0) / (simulations.length || 1),
    projection: proj,
    selections,
  };

  return {
    fingerprint,
    engineVersion: SIMULATION_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    simulations,
    aggregate,
  };
}

export type StoredBatch = {
  id: string;
  game_id: string;
  input_fingerprint: string;
  engine_version: string;
  runs: number;
  generated_at: string;
  simulations: SimOutcome[];
  aggregate: SimAggregate;
};

/** Latest stored batch for a game, or null. */
export async function readStoredBatch(gameId: string): Promise<StoredBatch | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("game_simulations")
    .select("*")
    .eq("game_id", gameId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as unknown as StoredBatch | null) ?? null;
}

/** Persist a batch. Duplicate (game, fingerprint) pairs are updated, never doubled. */
export async function storeBatch(
  game: GameRow,
  batch: SimulationBatch,
  analysisId: string | null,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("game_simulations").upsert(
    {
      game_id: game.id,
      sport: game.sport,
      analysis_id: analysisId,
      input_fingerprint: batch.fingerprint,
      engine_version: batch.engineVersion,
      runs: batch.simulations.length,
      generated_at: batch.generatedAt,
      simulations: batch.simulations as unknown as never,
      aggregate: batch.aggregate as unknown as never,
    } as never,
    { onConflict: "game_id,input_fingerprint" },
  );
  if (error) console.error("[sim] failed to store batch", game.id, error.message);
}

/** A stored batch only counts when it matches the current inputs exactly. */
export function batchIsCurrent(batch: StoredBatch | null, fingerprint: string): boolean {
  return Boolean(
    batch &&
      batch.input_fingerprint === fingerprint &&
      batch.engine_version === SIMULATION_ENGINE_VERSION &&
      (batch.runs ?? 0) >= SIMULATION_RUNS,
  );
}

export type { PickBet };
