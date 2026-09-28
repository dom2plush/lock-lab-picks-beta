/**
 * The 100 Lock Lab game simulations.
 *
 * Each run is a full simulated final score generated from the fair model's
 * margin and total, not a coin flip on a pre-chosen bet. Every spread,
 * total and moneyline candidate — standard or alternate — is then graded
 * against the SAME 100 scores, so no market can be priced by a different rule
 * than its neighbour and no alternate line can manufacture an edge.
 *
 * Scoring variance is deliberately football-shaped rather than a single tidy
 * bell curve: a share of runs draw from a wide regime (shootouts, blowouts),
 * defensive and special-teams touchdowns are added as discrete events, drive
 * killing turnovers remove scores, and trailing teams score late. That keeps
 * totals from piling up on the posted number.
 *
 * The raw run hit rate is deliberately not trusted on its own: it is
 * shrunk toward the model's own analytic probability, so 96/100 on a thin
 * sample cannot masquerade as a 96% bet.
 */
import type { FairModel } from "./fair-model.server";
import type { GameRow, Sport } from "./lock-lab-types";
import { SIMULATION_RUNS, mulberry32, seedFrom } from "./simulation.server";

/** Scatter of final margins around the fair spread. */
const MARGIN_SIGMA: Record<Sport, number> = { NFL: 13.2, CFB: 16.0 };
/** Scatter of combined scores around the fair total. */
const TOTAL_SIGMA: Record<Sport, number> = { NFL: 10.4, CFB: 12.8 };
/** Weight of the analytic model when smoothing the simulated count. */
const SHRINK_RUNS = 12;

/** Share of runs drawn from the wide "explosive game" regime. */
const WIDE_REGIME_SHARE = 0.18;
/** How much wider that regime is. */
const WIDE_REGIME_SCALE = 1.85;
/** Narrow regime scale, so the blend keeps roughly the intended sigma. */
const BASE_REGIME_SCALE = 0.92;
/** Chance a team returns a turnover or kick for a touchdown in a given game. */
const DEFENSIVE_TD_CHANCE = 0.11;
/** Chance a turnover or failed drive wipes out a score for a team. */
const DRIVE_KILL_CHANCE = 0.22;
/** Chance a trailing team adds a late comeback score when down two scores. */
const COMEBACK_CHANCE = 0.34;

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

/** Internal audit view of the simulated distribution. Not shown on the card. */
export type SimulationDiagnostics = {
  runs: number;
  avgHomeScore: number;
  avgAwayScore: number;
  medianHomeScore: number;
  medianAwayScore: number;
  avgTotal: number;
  medianTotal: number;
  totalVariance: number;
  totalStdDev: number;
  minTotal: number;
  maxTotal: number;
  avgMargin: number;
  medianMargin: number;
  marginVariance: number;
  marginStdDev: number;
  minMargin: number;
  maxMargin: number;
  homeWins: number;
  awayWins: number;
  ties: number;
  /** Count of runs falling in each total band. */
  totalDistribution: { label: string; from: number; to: number | null; runs: number }[];
};

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
  /** Audit numbers for the simulated distribution, or null with no runs. */
  diagnostics: SimulationDiagnostics | null;
  /** Chance this team covers the given handicap (positive = getting points). */
  spreadProb(team: "home" | "away", point: number): number | null;
  /** Chance the game goes over/under this number. */
  totalProb(side: "Over" | "Under", point: number): number | null;
  /** Chance this team wins outright. */
  moneylineProb(team: "home" | "away"): number | null;
  /** Per-run win/lose vector for a handicap, graded on the same scores. */
  spreadOutcomes(team: "home" | "away", point: number): boolean[] | null;
  /** Per-run win/lose vector for a total. */
  totalOutcomes(side: "Over" | "Under", point: number): boolean[] | null;
  /** Per-run win/lose vector for a moneyline. */
  moneylineOutcomes(team: "home" | "away"): boolean[] | null;
};

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
}

const TOTAL_BANDS: { label: string; from: number; to: number | null }[] = [
  { label: "under 37", from: -Infinity, to: 36.5 },
  { label: "37-43", from: 36.5, to: 43.5 },
  { label: "44-50", from: 43.5, to: 50.5 },
  { label: "51-57", from: 50.5, to: 57.5 },
  { label: "58+", from: 57.5, to: null },
];

function buildDiagnostics(scores: SimulatedScore[]): SimulationDiagnostics | null {
  if (!scores.length) return null;
  const homes = scores.map((s) => s.home);
  const aways = scores.map((s) => s.away);
  const totals = scores.map((s) => s.total);
  const margins = scores.map((s) => s.margin);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    runs: scores.length,
    avgHomeScore: round(mean(homes)),
    avgAwayScore: round(mean(aways)),
    medianHomeScore: medianOf(homes),
    medianAwayScore: medianOf(aways),
    avgTotal: round(mean(totals)),
    medianTotal: medianOf(totals),
    totalVariance: round(variance(totals)),
    totalStdDev: round(Math.sqrt(variance(totals))),
    minTotal: Math.min(...totals),
    maxTotal: Math.max(...totals),
    avgMargin: round(mean(margins)),
    medianMargin: medianOf(margins),
    marginVariance: round(variance(margins)),
    marginStdDev: round(Math.sqrt(variance(margins))),
    minMargin: Math.min(...margins),
    maxMargin: Math.max(...margins),
    homeWins: margins.filter((m) => m > 0).length,
    awayWins: margins.filter((m) => m < 0).length,
    ties: margins.filter((m) => m === 0).length,
    totalDistribution: TOTAL_BANDS.map((band) => ({
      label: band.label,
      from: band.from === -Infinity ? 0 : band.from,
      to: band.to,
      runs: totals.filter((t) => t > band.from && (band.to == null || t < band.to)).length,
    })),
  };
}


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
  // Seeded from the game and the model version only: the same game on the same
  // engine always draws the exact same 100 simulated scores for every user.
  const seed = seedFrom(simulationSeedKey(game));
  const rand = mulberry32(seed);

  const scores: SimulatedScore[] = [];
  if (fairMargin != null && fairTotal != null) {
    for (let run = 1; run <= runs; run += 1) {
      // Two scoring regimes: most games are ordinary, a minority are explosive
      // shootouts or blowouts. This keeps the tails populated instead of
      // stacking every run on the posted number.
      const wide = rand() < WIDE_REGIME_SHARE;
      const scale = wide ? WIDE_REGIME_SCALE : BASE_REGIME_SCALE;
      const margin = fairMargin + gaussian(rand) * marginSigma * scale;
      const total = Math.max(10, fairTotal + gaussian(rand) * totalSigma * scale);

      let home = (total + margin) / 2;
      let away = (total - margin) / 2;

      // Defensive / special-teams touchdowns: points scored without an
      // offensive drive, which the margin-and-total draw cannot produce.
      if (rand() < DEFENSIVE_TD_CHANCE) home += 7;
      if (rand() < DEFENSIVE_TD_CHANCE) away += 7;

      // Turnovers and failed drives inside scoring range remove points.
      if (rand() < DRIVE_KILL_CHANCE) home -= rand() < 0.5 ? 3 : 7;
      if (rand() < DRIVE_KILL_CHANCE) away -= rand() < 0.5 ? 3 : 7;

      // Game state: a team down two scores late plays faster and often adds
      // one more touchdown, which lifts the total without flipping the game.
      const gap = home - away;
      if (Math.abs(gap) >= 11 && rand() < COMEBACK_CHANCE) {
        if (gap > 0) away += rand() < 0.35 ? 8 : 7;
        else home += rand() < 0.35 ? 8 : 7;
      }

      const homeScore = snapScore(home);
      const awayScore = snapScore(away);
      scores.push({
        run,
        home: homeScore,
        away: awayScore,
        margin: homeScore - awayScore,
        total: homeScore + awayScore,
      });
    }
  }


  // Effective spread of the two-regime draw, so the analytic anchor used for
  // shrinkage matches the widened simulated distribution.
  const REGIME_SIGMA =
    Math.sqrt((1 - WIDE_REGIME_SHARE) * BASE_REGIME_SCALE ** 2 + WIDE_REGIME_SHARE * WIDE_REGIME_SCALE ** 2);
  const effMarginSigma = marginSigma * REGIME_SIGMA;
  const effTotalSigma = totalSigma * REGIME_SIGMA;

  const analyticSpread = (teamMargin: number, point: number) =>
    normalCdf((teamMargin + point) / effMarginSigma);

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
        ? normalCdf((fairTotal - point) / effTotalSigma)
        : normalCdf((point - fairTotal) / effTotalSigma);
    return shrink(hits, decided, analytic);
  }

  function moneylineProb(team: "home" | "away"): number | null {
    return spreadProb(team, 0);
  }

  /**
   * Settlement vectors. The published hit count for a game pick is the number
   * of these same 50 simulated finals it won — a push counts as a loss rather
   * than being quietly removed from the denominator.
   */
  function spreadOutcomes(team: "home" | "away", point: number): boolean[] | null {
    if (!scores.length) return null;
    return scores.map((score) => (team === "home" ? score.margin : -score.margin) + point > 0);
  }

  function totalOutcomes(side: "Over" | "Under", point: number): boolean[] | null {
    if (!scores.length) return null;
    return scores.map((score) => (side === "Over" ? score.total > point : score.total < point));
  }

  function moneylineOutcomes(team: "home" | "away"): boolean[] | null {
    return spreadOutcomes(team, 0);
  }


  const homeWinProb = moneylineProb("home");
  const diagnostics = buildDiagnostics(scores);
  const notes = [...fair.notes];
  if (diagnostics) {
    notes.push(
      `${runs} simulated final scores off that fair line: average margin ${diagnostics.avgMargin.toFixed(1)} to ${game.home_team}, average total ${diagnostics.avgTotal.toFixed(1)}, ${game.home_team} wins ${((homeWinProb ?? 0) * 100).toFixed(1)}% of runs. Every spread, total, moneyline, alternate line and player prop below is graded against these same ${runs} runs.`,
      `Simulation diagnostics: median total ${diagnostics.medianTotal}, total spread ${diagnostics.minTotal}-${diagnostics.maxTotal} (sd ${diagnostics.totalStdDev}), median margin ${diagnostics.medianMargin}, margin spread ${diagnostics.minMargin} to ${diagnostics.maxMargin} (sd ${diagnostics.marginStdDev}), outright ${diagnostics.homeWins}-${diagnostics.awayWins}-${diagnostics.ties}; totals ${diagnostics.totalDistribution
        .map((band) => `${band.label}: ${band.runs}`)
        .join(", ")}.`,
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
    diagnostics,
    spreadProb,
    totalProb,
    moneylineProb,
    spreadOutcomes,
    totalOutcomes,
    moneylineOutcomes,
  };
}
