/**
 * The 50 Lock Lab game simulations.
 *
 * Each run is a full simulated final score generated from the fair model's
 * margin and total, not a coin flip on a pre-chosen bet. Every spread,
 * total and moneyline candidate — standard or alternate — is then graded
 * against the SAME 50 scores, so no market can be priced by a different rule
 * than its neighbour and no alternate line can manufacture an edge.
 *
 * The raw 50-run hit rate is deliberately not trusted on its own: it is
 * shrunk toward the model's own analytic probability, so 48/50 on a thin
 * sample cannot masquerade as a 96% bet.
 */
import type { FairModel } from "./fair-model.server";
import type { GameRow, Sport } from "./lock-lab-types";
import { SIMULATION_RUNS, mulberry32, seedFrom } from "./simulation.server";

/** Scatter of final margins around the fair spread. */
const MARGIN_SIGMA: Record<Sport, number> = { NFL: 13.2, CFB: 16.0 };
/** Scatter of combined scores around the fair total. */
const TOTAL_SIGMA: Record<Sport, number> = { NFL: 10.4, CFB: 12.8 };
/** Weight of the analytic model when smoothing the 50-run count. */
const SHRINK_RUNS = 12;

/** Final scores that actually occur in football, used to keep runs realistic. */
const PLAUSIBLE = [
  0, 3, 6, 7, 9, 10, 13, 14, 16, 17, 19, 20, 21, 23, 24, 26, 27, 28, 30, 31, 33, 34, 35, 37, 38, 41,
  42, 44, 45, 48, 49, 52, 55, 59, 62,
];

function snapScore(value: number): number {
  const bounded = Math.max(0, value);
  let best = PLAUSIBLE[0]!;
  for (const score of PLAUSIBLE) {
    if (Math.abs(score - bounded) < Math.abs(best - bounded)) best = score;
  }
  return best;
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Box–Muller draw from a seeded uniform source. */
function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type SimulatedScore = { run: number; home: number; away: number; margin: number; total: number };

export type GameProjection = {
  runs: number;
  scores: SimulatedScore[];
  fairMargin: number | null;
  fairTotal: number | null;
  /** Fair home win probability from the simulated distribution. */
  homeWinProb: number | null;
  /** 0-1 confidence in the underlying model inputs. */
  confidence: number;
  notes: string[];
  /** Chance this team covers the given handicap (positive = getting points). */
  spreadProb(team: "home" | "away", point: number): number | null;
  /** Chance the game goes over/under this number. */
  totalProb(side: "Over" | "Under", point: number): number | null;
  /** Chance this team wins outright. */
  moneylineProb(team: "home" | "away"): number | null;
  /** Per-run win/lose vector for a handicap, graded on the same 50 scores. */
  spreadOutcomes(team: "home" | "away", point: number): boolean[] | null;
  /** Per-run win/lose vector for a total. */
  totalOutcomes(side: "Over" | "Under", point: number): boolean[] | null;
  /** Per-run win/lose vector for a moneyline. */
  moneylineOutcomes(team: "home" | "away"): boolean[] | null;
};

/**
 * Blends the simulated count with the analytic probability from the same fair
 * line. Keeps the 50 runs meaningful without letting sampling noise dominate.
 */
function shrink(hits: number, decided: number, analytic: number): number {
  if (decided <= 0) return analytic;
  const blended = (hits + SHRINK_RUNS * analytic) / (decided + SHRINK_RUNS);
  return Math.min(0.985, Math.max(0.015, blended));
}

/**
 * Runs {@link SIMULATION_RUNS} independent simulated games off the fair model.
 * Deterministic for a given game and snapshot, so every user sees identical
 * numbers and Analyze never has to re-roll them.
 */
export function simulateGame(game: GameRow, fair: FairModel, runs = SIMULATION_RUNS): GameProjection {
  const fairMargin = fair.fairMargin;
  const fairTotal = fair.fairTotal;
  const marginSigma = MARGIN_SIGMA[game.sport];
  const totalSigma = TOTAL_SIGMA[game.sport];
  const seed = seedFrom(
    `${game.id}:${game.odds?.capturedAt ?? game.odds_updated_at ?? ""}:${fairMargin ?? "-"}:${fairTotal ?? "-"}`,
  );
  const rand = mulberry32(seed);

  const scores: SimulatedScore[] = [];
  if (fairMargin != null && fairTotal != null) {
    for (let run = 1; run <= runs; run += 1) {
      const margin = fairMargin + gaussian(rand) * marginSigma;
      const total = Math.max(17, fairTotal + gaussian(rand) * totalSigma);
      const home = snapScore((total + margin) / 2);
      const away = snapScore((total - margin) / 2);
      scores.push({ run, home, away, margin: home - away, total: home + away });
    }
  }

  const analyticSpread = (teamMargin: number, point: number) =>
    normalCdf((teamMargin + point) / marginSigma);

  function spreadProb(team: "home" | "away", point: number): number | null {
    if (fairMargin == null || !scores.length) return null;
    const teamMargin = team === "home" ? fairMargin : -fairMargin;
    let hits = 0;
    let decided = 0;
    for (const score of scores) {
      const value = (team === "home" ? score.margin : -score.margin) + point;
      if (value === 0) continue; // push
      decided += 1;
      if (value > 0) hits += 1;
    }
    return shrink(hits, decided, analyticSpread(teamMargin, point));
  }

  function totalProb(side: "Over" | "Under", point: number): number | null {
    if (fairTotal == null || !scores.length) return null;
    let hits = 0;
    let decided = 0;
    for (const score of scores) {
      if (score.total === point) continue; // push
      decided += 1;
      const over = score.total > point;
      if ((side === "Over" && over) || (side === "Under" && !over)) hits += 1;
    }
    const analytic =
      side === "Over"
        ? normalCdf((fairTotal - point) / totalSigma)
        : normalCdf((point - fairTotal) / totalSigma);
    return shrink(hits, decided, analytic);
  }

  function moneylineProb(team: "home" | "away"): number | null {
    return spreadProb(team, 0);
  }

  const homeWinProb = moneylineProb("home");
  const notes = [...fair.notes];
  if (scores.length) {
    const avgMargin = scores.reduce((sum, s) => sum + s.margin, 0) / scores.length;
    const avgTotal = scores.reduce((sum, s) => sum + s.total, 0) / scores.length;
    notes.push(
      `${runs} simulated final scores off that fair line: average margin ${avgMargin.toFixed(1)} to ${game.home_team}, average total ${avgTotal.toFixed(1)}, ${game.home_team} wins ${((homeWinProb ?? 0) * 100).toFixed(1)}% of runs. Every spread, total and moneyline price below is graded against these same 50 runs.`,
    );
  } else {
    notes.push(
      "SIMULATION UNAVAILABLE: no fair spread and total could be established, so no simulated probability exists for this game.",
    );
  }

  return {
    runs: scores.length,
    scores,
    fairMargin,
    fairTotal,
    homeWinProb,
    confidence: fair.inputs.confidence,
    notes,
    spreadProb,
    totalProb,
    moneylineProb,
  };
}
