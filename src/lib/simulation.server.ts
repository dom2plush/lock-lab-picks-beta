/**
 * Shared pieces of the precomputed Lock Lab simulation batch: the input
 * fingerprint that decides when a batch is stale, and the deterministic
 * random source used to settle the formula's picks 50 times.
 */
import type { AnalysisRow, GameRow } from "./lock-lab-types";

export const SIMULATION_ENGINE_VERSION = "sim-v12";
export const SIMULATION_RUNS = 50;

/** Rounds a price so tiny juice wiggles do not invalidate a stored batch. */
function priceBucket(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return Math.round(price / 10) * 10;
}

/**
 * Every input that would make Lock Lab want a different answer: the posted
 * numbers, the material juice, and the injury/QB report. Cosmetic changes
 * (capture timestamps, unchanged re-pulls) deliberately do not move it.
 */
export function inputFingerprint(game: GameRow): string {
  const odds = game.odds ?? {};
  const injuries = (game.injuries ?? [])
    .map((injury) => `${injury.team}|${injury.player}|${injury.status}`)
    .sort()
    .join(";");
  const payload = [
    SIMULATION_ENGINE_VERSION,
    game.id,
    game.sport,
    odds.bookmakerKey ?? odds.bookmaker ?? "",
    odds.spread ? `${odds.spread.home}/${priceBucket(odds.spread.homePrice)}/${priceBucket(odds.spread.awayPrice)}` : "",
    odds.total ? `${odds.total.points}/${priceBucket(odds.total.overPrice)}/${priceBucket(odds.total.underPrice)}` : "",
    odds.moneyline ? `${priceBucket(odds.moneyline.home)}/${priceBucket(odds.moneyline.away)}` : "",
    injuries,
  ].join("::");
  return hash(payload);
}

/** Stable, dependency-free 32-bit string hash rendered as hex. */
export function hash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 + code + i, 2654435761) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Seeded PRNG so a batch is reproducible for the same inputs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  return parseInt(hash(text).slice(0, 8), 16) >>> 0;
}

export type SimulatedPick = {
  key: string;
  section: "top" | "prop" | "fun";
  label: string;
  probability: number;
  wins: number;
  hitRate: number;
};

export type SimulationRun = {
  run: number;
  hits: string[];
};

export type SimulationAggregate = {
  runs: number;
  picks: SimulatedPick[];
  generatedAt: string;
};

export function americanToProbability(odds: string | null | undefined): number | null {
  if (!odds) return null;
  const price = Number(odds.replace("+", ""));
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
}

type PickInput = {
  key: string;
  section: SimulatedPick["section"];
  label: string;
  probability: number;
  /**
   * Run numbers this pick won in the 50 simulated games. When present the
   * settlement pass simply reads them: no coin flip is ever used for a pick
   * the simulated games already decided.
   */
  hits?: number[] | null;
};

/** Every posted pick in a finished analysis, with the probability to settle it on. */
export function picksToSimulate(analysis: {
  top_bets: AnalysisRow["top_bets"];
  player_props: AnalysisRow["player_props"];
  fun_bets: AnalysisRow["fun_bets"];
}): PickInput[] {
  const out: PickInput[] = [];
  for (const bet of analysis.top_bets ?? []) {
    out.push({
      key: bet.key,
      section: "top",
      label: bet.label,
      probability: americanToProbability(bet.odds) ?? 0.5,
      hits: bet.simHits ?? null,
    });
  }
  for (const prop of analysis.player_props ?? []) {
    out.push({
      key: prop.key,
      section: "prop",
      label: prop.label,
      probability: prop.estimatedProbability ?? americanToProbability(prop.odds) ?? 0.5,
      hits: prop.simHits ?? null,
    });
  }
  for (const fun of analysis.fun_bets ?? []) {
    out.push({
      key: fun.key,
      section: "fun",
      label: fun.label,
      probability: fun.estimatedProbability ?? americanToProbability(fun.odds) ?? 0.5,
      hits: fun.simHits ?? null,
    });
  }
  return out;
}

/**
 * Runs the settled board {@link SIMULATION_RUNS} times. Each run is an
 * independent deterministic execution seeded from the game fingerprint, so the
 * same inputs always produce the same 50 outcomes for every user.
 */
export function runSimulations(
  fingerprint: string,
  picks: PickInput[],
  runs = SIMULATION_RUNS,
): { simulations: SimulationRun[]; aggregate: SimulationAggregate } {
  const wins = new Map<string, number>();
  const simulations: SimulationRun[] = [];

  // Picks settled inside the simulated games carry their own per-run result.
  const settled = new Map<string, Set<number>>();
  for (const pick of picks) {
    if (pick.hits) settled.set(pick.key, new Set(pick.hits));
  }

  for (let run = 1; run <= runs; run += 1) {
    const hits: string[] = [];
    for (const pick of picks) {
      const decided = settled.get(pick.key);
      const won = decided
        ? decided.has(run)
        : mulberry32(seedFrom(`${fingerprint}:${pick.key}:${run}`))() <
          Math.min(0.97, Math.max(0.03, pick.probability));
      if (won) {
        hits.push(pick.key);
        wins.set(pick.key, (wins.get(pick.key) ?? 0) + 1);
      }
    }
    simulations.push({ run, hits });
  }

  return {
    simulations,
    aggregate: {
      runs,
      generatedAt: new Date().toISOString(),
      picks: picks.map((pick) => {
        const won = wins.get(pick.key) ?? 0;
        return {
          key: pick.key,
          section: pick.section,
          label: pick.label,
          probability: pick.probability,
          wins: won,
          hitRate: runs ? won / runs : 0,
        };
      }),
    },
  };
}
