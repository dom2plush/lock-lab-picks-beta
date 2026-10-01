/**
 * Base-vs-stress robustness for any pick settled inside the 1,000 simulated
 * games. Runs 1..BASE_RUNS are the Base Model; the next STRESS_RUNS runs are
 * the Stress Test, which deliberately varies key assumptions. A pick's hits
 * are stored as 1-based run numbers, so the two sets are always recoverable.
 *
 * Pure and client-safe: used by the engine and by the analysis popup.
 */
import type { Badge } from "./lock-lab-types";

export const BASE_RUNS = 500;
export const STRESS_RUNS = 500;
export const TOTAL_RUNS = BASE_RUNS + STRESS_RUNS;

/** Combined edge at or above this is "meaningful" for GREEN. */
export const GREEN_MIN_EDGE = 0.02;
/** Stress edge may be slightly negative and still allow GREEN (confidence modifier, not a veto). */
export const GREEN_STRESS_FLOOR = -0.015;
/** Stress edge below this — or a stress result this far under break-even — is a clear collapse. */
export const STRESS_COLLAPSE_EDGE = -0.03;
/** Edges this large are treated as suspicious and need stronger robustness. */
export const LARGE_EDGE = 0.12;
/** Model-vs-market gaps at or above this raise the disagreement warning. */
export const DISAGREEMENT_WARNING = 0.06;

export type AgreementLevel = "HIGH" | "MEDIUM" | "LOW";

export type Robustness = {
  baseRuns: number;
  stressRuns: number;
  baseHitRate: number;
  stressHitRate: number;
  combinedHitRate: number;
  impliedProbability: number;
  baseEdge: number;
  stressEdge: number;
  combinedEdge: number;
  expectedRoi: number;
  /** 0..1, 1 = Base and Stress hit rates identical. */
  agreementScore: number;
  agreementLevel: AgreementLevel;
};

/** Correct American-odds conversion: -150 → 150/250, +150 → 100/250. */
export function impliedProbability(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/** Profit per unit staked on a win at this American price. */
export function winPayout(price: number): number {
  return price > 0 ? price / 100 : 100 / -price;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function agreementFromGap(gap: number): { score: number; level: AgreementLevel } {
  // 0 pts apart → 1.0, 10+ pts apart → 0.
  const score = clamp01(1 - Math.abs(gap) / 0.1);
  const level: AgreementLevel = Math.abs(gap) <= 0.03 ? "HIGH" : Math.abs(gap) <= 0.06 ? "MEDIUM" : "LOW";
  return { score: Math.round(score * 1000) / 1000, level };
}

/**
 * Splits a pick's winning run numbers into Base and Stress sets and measures
 * each against the exact posted price. A push is never a win, so it is simply
 * absent from the hit list and counts against the denominator.
 */
export function robustnessFromHits(
  hits: readonly number[] | null | undefined,
  runs: number | null | undefined,
  price: number | null | undefined,
): Robustness | null {
  if (!hits || !runs || price == null) return null;
  const implied = impliedProbability(price);
  if (implied == null) return null;
  const baseRuns = Math.min(BASE_RUNS, runs);
  const stressRuns = Math.max(0, runs - BASE_RUNS);
  if (baseRuns <= 0 || stressRuns <= 0) return null;
  let baseHits = 0;
  let stressHits = 0;
  for (const run of hits) {
    if (run >= 1 && run <= baseRuns) baseHits += 1;
    else if (run > baseRuns && run <= runs) stressHits += 1;
  }
  const baseHitRate = baseHits / baseRuns;
  const stressHitRate = stressHits / stressRuns;
  const combinedHitRate = (baseHits + stressHits) / runs;
  const payout = winPayout(price);
  const { score, level } = agreementFromGap(baseHitRate - stressHitRate);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    baseRuns,
    stressRuns,
    baseHitRate: r4(baseHitRate),
    stressHitRate: r4(stressHitRate),
    combinedHitRate: r4(combinedHitRate),
    impliedProbability: r4(implied),
    baseEdge: r4(baseHitRate - implied),
    stressEdge: r4(stressHitRate - implied),
    combinedEdge: r4(combinedHitRate - implied),
    expectedRoi: r4(combinedHitRate * payout - (1 - combinedHitRate)),
    agreementScore: score,
    agreementLevel: level,
  };
}

/** Same as {@link robustnessFromHits} from a per-run win vector. */
export function robustnessFromOutcomes(outcomes: readonly boolean[] | null | undefined, price: number): Robustness | null {
  if (!outcomes || !outcomes.length) return null;
  const hits: number[] = [];
  outcomes.forEach((won, i) => won && hits.push(i + 1));
  return robustnessFromHits(hits, outcomes.length, price);
}

/** True when the stress test clearly wipes out the edge. */
export function stressCollapsed(r: Robustness): boolean {
  return r.stressEdge < STRESS_COLLAPSE_EDGE || (r.agreementLevel === "LOW" && r.stressEdge < 0);
}

/**
 * GREEN = robust edge, YELLOW = fragile / lean edge, RED = no edge.
 * The stress test modifies confidence; it only vetoes on a clear collapse.
 * Very large edges must also be well corroborated before they earn GREEN.
 */
export function robustBadge(r: Robustness | null, opts: { dataOk?: boolean } = {}): Badge {
  if (!r) return "red";
  if (r.combinedEdge <= 0 || r.expectedRoi <= 0) return "red";
  if (stressCollapsed(r)) return "red";
  const dataOk = opts.dataOk ?? true;
  const large = r.combinedEdge >= LARGE_EDGE;
  const green =
    dataOk &&
    r.combinedEdge >= GREEN_MIN_EDGE &&
    r.stressEdge >= GREEN_STRESS_FLOOR &&
    r.agreementLevel !== "LOW" &&
    (!large || (r.agreementLevel === "HIGH" && r.stressEdge >= 0.03));
  return green ? "green" : "yellow";
}

/** How the stress test reads a model-vs-market disagreement. */
export function disagreementVerdict(r: Robustness): "supported" | "weakened" | "uncertain" {
  if (stressCollapsed(r)) return "uncertain";
  if (r.stressEdge >= r.combinedEdge * 0.6 && r.agreementLevel !== "LOW") return "supported";
  return r.stressEdge > 0 ? "weakened" : "uncertain";
}

/** Fields stored on every settled pick. */
export function robustFields(r: Robustness | null) {
  if (!r) return {};
  return {
    baseHitRate: r.baseHitRate,
    stressHitRate: r.stressHitRate,
    combinedHitRate: r.combinedHitRate,
    baseEdge: r.baseEdge,
    stressEdge: r.stressEdge,
    combinedEdge: r.combinedEdge,
    impliedProbability: r.impliedProbability,
    agreementScore: r.agreementScore,
    agreementLevel: r.agreementLevel,
    expectedRoi: r.expectedRoi,
    modelEdge: r.combinedEdge,
    simHitRate: r.combinedHitRate,
  };
}
