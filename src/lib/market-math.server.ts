/**
 * Market-first quantitative layer.
 *
 * Everything here works off the exact live odds snapshot: no invented prices,
 * no simulated team ratings. Its job is to say what the market itself is
 * pricing, where the price is internally inconsistent, and how much vig the
 * book is taking — the prior every Lock Lab read starts from.
 */
import type { GameOdds, Sport } from "./lock-lab-types";

/** Margin standard deviation: how far final results scatter around the spread. */
const MARGIN_SIGMA: Record<Sport, number> = { NFL: 13.2, CFB: 16.0 };

export function impliedProbability(american: number): number {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

/** Fair (vig-free) probabilities for a two-way market. */
export function devig(a: number, b: number): { a: number; b: number; hold: number } {
  const pa = impliedProbability(a);
  const pb = impliedProbability(b);
  const sum = pa + pb;
  return { a: pa / sum, b: pb / sum, hold: sum - 1 };
}

export function probabilityToAmerican(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

function normalCdf(z: number): number {
  // Abramowitz–Stegun erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Win probability for a team laying `margin` points, from the spread alone. */
export function spreadToWinProbability(margin: number, sport: Sport): number {
  return normalCdf(margin / MARGIN_SIGMA[sport]);
}

/** How often the game lands exactly on a key number — drives 3/7 line analysis. */
const KEY_NUMBERS: Record<Sport, Record<number, number>> = {
  NFL: { 3: 0.095, 7: 0.06, 6: 0.05, 4: 0.045, 10: 0.04, 14: 0.03 },
  CFB: { 3: 0.07, 7: 0.05, 10: 0.04, 14: 0.03, 4: 0.03 },
};

export type MarketRead = {
  /** Plain-language observations handed to the handicap pass. */
  notes: string[];
  /** Home margin the spread implies (positive = home favoured). */
  marketMargin: number | null;
  /** Fair home win probability implied by the spread. */
  spreadHomeWinProb: number | null;
  /** Fair home win probability implied by the moneyline after removing vig. */
  mlHomeWinProb: number | null;
  /** Percentage points the moneyline disagrees with the spread by. */
  mlDisagreement: number | null;
  spreadHold: number | null;
  totalHold: number | null;
  mlHold: number | null;
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function readMarket(
  odds: GameOdds,
  sport: Sport,
  teams: { home: string; away: string },
  previous?: GameOdds | null,
): MarketRead {
  const notes: string[] = [];
  const read: MarketRead = {
    notes,
    marketMargin: null,
    spreadHomeWinProb: null,
    mlHomeWinProb: null,
    mlDisagreement: null,
    spreadHold: null,
    totalHold: null,
    mlHold: null,
  };

  const { spread, total, moneyline } = odds;

  if (spread) {
    read.marketMargin = -spread.home;
    read.spreadHomeWinProb = spreadToWinProbability(-spread.home, sport);
    const { hold } = devig(spread.homePrice, spread.awayPrice);
    read.spreadHold = hold;
    notes.push(
      `Spread: ${teams.home} ${spread.home > 0 ? "+" : ""}${spread.home} (${spread.homePrice}) / ${teams.away} ${
        spread.away > 0 ? "+" : ""
      }${spread.away} (${spread.awayPrice}); book hold ${pct(hold)}; market margin ${(-spread.home).toFixed(1)} to ${teams.home}.`,
    );

    const abs = Math.abs(spread.home);
    const keys = KEY_NUMBERS[sport];
    const nearestKey = Object.keys(keys)
      .map(Number)
      .find((k) => Math.abs(abs - k) <= 0.5);
    if (nearestKey) {
      const density = keys[nearestKey] ?? 0;
      if (abs < nearestKey) {
        notes.push(
          `Key number: the line sits just under ${nearestKey}, which lands about ${pct(density)} of the time — the favourite side is buying the hook, the dog side is short of it.`,
        );
      } else if (abs > nearestKey) {
        notes.push(
          `Key number: the line sits just over ${nearestKey} (${pct(density)} of games land there) — the underdog is getting the number plus the hook, which is the valuable side of this pair.`,
        );
      } else {
        notes.push(`Key number: the line is exactly on ${nearestKey}, the single most common margin.`);
      }
    }

    const priceGap = Math.abs(spread.homePrice - spread.awayPrice);
    if (priceGap >= 20) {
      notes.push(
        `Spread juice is lopsided (${spread.homePrice} vs ${spread.awayPrice}): the book is part-way to moving the number, so the cheap side is the one the market is leaning off.`,
      );
    }
  }

  if (total) {
    const { hold } = devig(total.overPrice, total.underPrice);
    read.totalHold = hold;
    notes.push(
      `Total: ${total.points} (Over ${total.overPrice} / Under ${total.underPrice}); book hold ${pct(hold)}.`,
    );
    if (Math.abs(total.overPrice - total.underPrice) >= 20) {
      notes.push(
        `Total juice is lopsided (${total.overPrice} vs ${total.underPrice}) — money has come in on the expensive side without the number moving yet.`,
      );
    }
  }

  if (moneyline) {
    const fair = devig(moneyline.home, moneyline.away);
    read.mlHomeWinProb = fair.a;
    read.mlHold = fair.hold;
    notes.push(
      `Moneyline: ${teams.home} ${moneyline.home} / ${teams.away} ${moneyline.away}; vig-free ${teams.home} win ${pct(fair.a)}; book hold ${pct(fair.hold)}.`,
    );
    if (read.spreadHomeWinProb != null) {
      const diff = fair.a - read.spreadHomeWinProb;
      read.mlDisagreement = diff;
      if (Math.abs(diff) >= 0.03) {
        const cheapSide = diff > 0 ? teams.away : teams.home;
        notes.push(
          `Internal mispricing: the moneyline and the spread disagree by ${pct(Math.abs(diff))} on the same game. The ${cheapSide} moneyline is the cheap side of that disagreement — this is a measurable reason, not a hunch.`,
        );
      } else {
        notes.push(
          "Moneyline and spread agree to within a rounding error — no internal pricing edge between them.",
        );
      }
    }
    if (fair.hold >= 0.05) {
      notes.push(
        `High hold (${pct(fair.hold)}) on this moneyline: the book is charging heavily, which usually makes both sides losing propositions.`,
      );
    }
  }

  if (previous) {
    const moves: string[] = [];
    if (previous.spread && spread && previous.spread.home !== spread.home) {
      moves.push(
        `spread moved ${previous.spread.home > 0 ? "+" : ""}${previous.spread.home} → ${spread.home > 0 ? "+" : ""}${spread.home} on ${teams.home}`,
      );
    }
    if (previous.total && total && previous.total.points !== total.points) {
      moves.push(`total moved ${previous.total.points} → ${total.points}`);
    }
    if (moves.length) {
      notes.push(
        `Line movement since the last snapshot: ${moves.join("; ")}. Movement away from a side is the market telling you where the informed money went.`,
      );
    } else {
      notes.push("No line movement since the last stored snapshot — the market is settled on this number.");
    }
  } else {
    notes.push("No prior snapshot stored for this game yet, so no line-movement read is available.");
  }

  return read;
}

/** Fair price for a side given its vig-free probability, used to grade posted prices. */
export function priceVsFair(posted: number, fairProbability: number): number {
  return fairProbability - impliedProbability(posted);
}

// ---------------------------------------------------------------------------
// Alternate-line value
// ---------------------------------------------------------------------------

/** Spread of final combined scores around the posted total. */
const TOTAL_SIGMA: Record<Sport, number> = { NFL: 10.4, CFB: 12.8 };

export type AltEvaluation = {
  market: "spread" | "total";
  /** Team name for a spread, "Over"/"Under" for a total. */
  side: string;
  point: number;
  price: number;
  /** The standard market line and price this alternate is measured against. */
  standardPoint: number;
  standardPrice: number;
  /** Modelled chance each version cashes. */
  winProb: number;
  standardWinProb: number;
  /** Chance gained (or lost) by taking the alternate instead of the standard. */
  probGain: number;
  /** Break-even cost of the alternate's price minus the standard's. */
  priceCost: number;
  /** Positive when the extra protection is worth more than the extra juice. */
  valueDelta: number;
  worthIt: boolean;
  /** Key numbers the move crosses, e.g. [3] for +2.5 -> +3.5. */
  keysCrossed: number[];
  note: string;
  /** Key-number + simulated-cover check for alternates that buy points. */
  keyGate?: { ok: boolean; why: string; simGain: number | null };
};

function clampProb(p: number) {
  return Math.min(0.99, Math.max(0.01, p));
}

/**
 * Key numbers whose push mass the move picks up. A spread side covers when the
 * margin beats -point, so moving from `from` to `to` sweeps the thresholds
 * between them; integers in that span are pure push/no-push swings the smooth
 * normal model under-prices.
 */
function keysBetween(from: number, to: number, sport: Sport): number[] {
  const lo = Math.min(-from, -to);
  const hi = Math.max(-from, -to);
  const keys = KEY_NUMBERS[sport];
  const hits: number[] = [];
  for (let n = Math.ceil(lo); n <= Math.floor(hi); n += 1) {
    const density = keys[Math.abs(n)];
    if (density) hits.push(Math.abs(n));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Key-number gate for alternates that BUY points
// ---------------------------------------------------------------------------

/**
 * Every football scoring margin reachable with touchdowns (7) and field goals
 * (3) up to 70 — 3, 6, 7, 10, 13, 14, 17, 20, 21, 24 … These are the margins
 * worth paying extra juice to cross on an alternate spread.
 */
function buildFootballKeyMargins(max: number): number[] {
  const out = new Set<number>();
  for (let td = 0; td * 7 <= max; td += 1) {
    for (let fg = 0; td * 7 + fg * 3 <= max; fg += 1) {
      const margin = td * 7 + fg * 3;
      if (margin > 0) out.add(margin);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export const FOOTBALL_KEY_MARGINS = buildFootballKeyMargins(70);

/** Margins worth paying extra juice to cross on an alternate spread. */
export const SPREAD_GATE_KEYS: Record<Sport, number[]> = {
  NFL: FOOTBALL_KEY_MARGINS,
  CFB: FOOTBALL_KEY_MARGINS,
};

/** Most common final combined scores — the only totals worth buying through. */
export const TOTAL_KEY_NUMBERS: Record<Sport, number[]> = {
  NFL: [37, 40, 41, 43, 44, 47, 51],
  CFB: [45, 48, 51, 52, 55, 58, 59],
};

/** Minimum extra covers out of the simulated games before a bought point counts. */
export const MIN_SIM_COVER_GAIN = 1;

/** Recognised spread key margins swept when moving from `from` to `to`. */
export function spreadGateKeysBetween(from: number, to: number, sport: Sport): number[] {
  const lo = Math.min(-from, -to);
  const hi = Math.max(-from, -to);
  const hits: number[] = [];
  for (let n = Math.ceil(lo); n <= Math.floor(hi); n += 1) {
    if (SPREAD_GATE_KEYS[sport].includes(Math.abs(n))) hits.push(Math.abs(n));
  }
  return hits;
}

/** Recognised total key numbers strictly between the standard and alternate totals. */
export function totalKeysBetween(standardPoint: number, altPoint: number, sport: Sport): number[] {
  const lo = Math.min(standardPoint, altPoint);
  const hi = Math.max(standardPoint, altPoint);
  return TOTAL_KEY_NUMBERS[sport].filter((n) => n > lo && n < hi);
}

export type KeyGateResult = { ok: boolean; keys: number[]; simGain: number | null; why: string };

/**
 * An alternate that buys points must cross a recognised football key number AND
 * the simulated games must confirm it actually wins more often than the standard
 * line. Alternates that sell points (better price, worse number) are untouched.
 */
export function keyNumberGate(input: {
  market: "spread" | "total";
  sport: Sport;
  side: string;
  standardPoint: number;
  point: number;
  standardHits: number | null;
  altHits: number | null;
  runs: number;
}): KeyGateResult {
  const buying =
    input.market === "spread"
      ? input.point > input.standardPoint
      : input.side === "Under"
        ? input.point > input.standardPoint
        : input.point < input.standardPoint;
  if (!buying) return { ok: true, keys: [], simGain: null, why: "" };

  const keys =
    input.market === "spread"
      ? spreadGateKeysBetween(input.standardPoint, input.point, input.sport)
      : totalKeysBetween(input.standardPoint, input.point, input.sport);
  const simGain =
    input.standardHits != null && input.altHits != null ? input.altHits - input.standardHits : null;

  if (!keys.length) {
    return {
      ok: false,
      keys,
      simGain,
      why: `Buying from ${input.standardPoint} to ${input.point} crosses no recognised ${
        input.market === "spread" ? "key margin" : "key scoring total"
      }, so the extra juice is not worth paying.`,
    };
  }
  if (simGain == null) {
    return { ok: false, keys, simGain, why: "The simulated games could not confirm any extra covers for this number." };
  }
  if (simGain < MIN_SIM_COVER_GAIN) {
    return {
      ok: false,
      keys,
      simGain,
      why: `Crosses ${keys.join(" and ")}, but only ${simGain} of ${input.runs} simulated games changed result — not a meaningful gain.`,
    };
  }
  return {
    ok: true,
    keys,
    simGain,
    why: `Crosses ${keys.join(" and ")}: ${simGain} more of ${input.runs} simulated games cash than the standard line.`,
  };
}

/** Alternate spread prices must sit in this negative-odds window. */
export const ALT_SPREAD_PRICE_MIN = -180;
export const ALT_SPREAD_PRICE_MAX = -100;

/** Plus-money alternates are only allowed when they are this sharp in the sims. */
export const ALT_SPREAD_PLUS_MIN_HIT_RATE = 0.7;
/** Longest plus-money price an alternate spread may carry. */
export const ALT_SPREAD_PLUS_PRICE_MAX = 199;

/** True when a plus-money alternate is sharp enough (>= 35 of 50 simulated covers). */
export function plusMoneyAltAllowed(altHits: number | null, runs: number): boolean {
  if (altHits == null || runs <= 0) return false;
  return altHits / runs >= ALT_SPREAD_PLUS_MIN_HIT_RATE;
}

/**
 * Direction and price rule for alternate spreads. The alternate must give the
 * bettor more protection (a higher number on the same side) and cross a real
 * football key margin. Price must be negative odds between -100 and -180, or
 * plus money between +100 and +199 when the simulated games back it at 70% or
 * better (35 of 50). Moving away from the key number is never allowed.
 */
export function alternateSpreadRule(input: {
  sport: Sport;
  standardPoint: number;
  point: number;
  price: number;
  altHits?: number | null;
  runs?: number;
}): { ok: boolean; keys: number[]; why: string } {
  if (!(input.point > input.standardPoint)) {
    return {
      ok: false,
      keys: [],
      why: `Moves from ${signedLine(input.standardPoint)} to ${signedLine(input.point)} — less protection, so this alternate is never used.`,
    };
  }
  const keys = spreadGateKeysBetween(input.standardPoint, input.point, input.sport);
  if (!keys.length) {
    return {
      ok: false,
      keys,
      why: `Moving from ${signedLine(input.standardPoint)} to ${signedLine(input.point)} crosses no key number, so this alternate is never used.`,
    };
  }
  if (input.price > 0) {
    const runs = input.runs ?? 50;
    const hits = input.altHits ?? null;
    if (input.price > ALT_SPREAD_PLUS_PRICE_MAX) {
      return { ok: false, keys, why: `Priced at +${input.price} — too long for a Top 2 bet.` };
    }
    if (input.price < 100) {
      return { ok: false, keys, why: `Priced at +${input.price} — not a usable alternate price.` };
    }
    if (!plusMoneyAltAllowed(hits, runs)) {
      return {
        ok: false,
        keys,
        why: `Priced at +${input.price}: plus money is only taken when at least ${Math.ceil(
          runs * ALT_SPREAD_PLUS_MIN_HIT_RATE,
        )} of ${runs} simulated games cash it${hits == null ? "" : ` (this one cashes ${hits})`}.`,
      };
    }
    return {
      ok: true,
      keys,
      why: `Plus money at +${input.price} with ${hits} of ${runs} simulated games cashing — sharp enough to take the extra return.`,
    };
  }
  if (input.price > ALT_SPREAD_PRICE_MAX || input.price < ALT_SPREAD_PRICE_MIN) {
    return {
      ok: false,
      keys,
      why: `Priced at ${input.price} — alternate spreads must be between -100 and ${ALT_SPREAD_PRICE_MIN}.`,
    };
  }
  return { ok: true, keys, why: "" };
}


function pts(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
}

function signedLine(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Grades every alternate spread/total against the standard line of the same
 * market: does the extra half-point (or extra points) buy more winning
 * probability than the extra juice costs? Prices and lines are the provider's;
 * nothing here invents a number.
 */
export function createAltEvaluator(
  odds: GameOdds,
  sport: Sport,
  teams: { home: string; away: string },
) {
  const sigma = MARGIN_SIGMA[sport];
  const totalSigma = TOTAL_SIGMA[sport];
  const spread = odds.spread;
  const total = odds.total;
  const marginHome = spread ? -spread.home : null;

  function spreadProb(team: string, point: number): number | null {
    if (marginHome == null) return null;
    const teamMargin = team === teams.home ? marginHome : -marginHome;
    return normalCdf((teamMargin + point) / sigma);
  }

  function totalProb(side: string, point: number): number | null {
    if (!total) return null;
    return side === "Over"
      ? normalCdf((total.points - point) / totalSigma)
      : normalCdf((point - total.points) / totalSigma);
  }

  function evaluateSpread(team: string, point: number, price: number): AltEvaluation | null {
    if (!spread || marginHome == null) return null;
    // An alternate is only ever compared with its own team's standard line.
    if (team !== teams.home && team !== teams.away) return null;
    const standardPoint = team === teams.home ? spread.home : spread.away;
    const standardPrice = team === teams.home ? spread.homePrice : spread.awayPrice;
    if (point === standardPoint) return null;
    const base = spreadProb(team, standardPoint);
    const raw = spreadProb(team, point);
    if (base == null || raw == null) return null;

    const keys = keysBetween(standardPoint, point, sport);
    const direction = point > standardPoint ? 1 : -1;
    // Half the key-number mass on top of the smooth model: the normal curve
    // already contains part of it, but not the push lump itself. Only a short
    // buy genuinely harvests it, and it is capped — a long move across five
    // numbers does not stack five lumps of extra win probability.
    const distance = Math.abs(point - standardPoint);
    const bump =
      distance <= 3
        ? Math.min(keys.reduce((sum, k) => sum + (KEY_NUMBERS[sport][k] ?? 0), 0) * 0.5, 0.06)
        : 0;
    const winProb = clampProb(raw + direction * bump);
    const standardWinProb = clampProb(base);

    return finish({
      market: "spread",
      side: team,
      point,
      price,
      standardPoint,
      standardPrice,
      winProb,
      standardWinProb,
      keysCrossed: keys,
      describe: `${team} ${signedLine(point)} (${price}) vs the standard ${signedLine(standardPoint)} (${standardPrice})`,
    });
  }

  function evaluateTotal(side: string, point: number, price: number): AltEvaluation | null {
    if (!total) return null;
    if (side !== "Over" && side !== "Under") return null;
    const standardPoint = total.points;
    const standardPrice = side === "Over" ? total.overPrice : total.underPrice;
    if (point === standardPoint) return null;
    const winProb = totalProb(side, point);
    const standardWinProb = totalProb(side, standardPoint);
    if (winProb == null || standardWinProb == null) return null;

    return finish({
      market: "total",
      side,
      point,
      price,
      standardPoint,
      standardPrice,
      winProb: clampProb(winProb),
      standardWinProb: clampProb(standardWinProb),
      keysCrossed: [],
      describe: `${side} ${point} (${price}) vs the standard ${side} ${standardPoint} (${standardPrice})`,
    });
  }

  function finish(input: Omit<AltEvaluation, "probGain" | "priceCost" | "valueDelta" | "worthIt" | "note"> & {
    describe: string;
  }): AltEvaluation {
    const probGain = input.winProb - input.standardWinProb;
    const priceCost = impliedProbability(input.price) - impliedProbability(input.standardPrice);
    // The further an alternate sits from the number the market actually made,
    // the less the model deserves to be trusted against the book's own pricing.
    // Without this haircut a deep alternate favourite always "wins" on paper.
    const distance = Math.abs(input.point - input.standardPoint);
    const haircut = 0.02 * Math.max(0, distance - 3);
    const valueDelta = probGain - priceCost - haircut;
    // A whole point of value, not a rounding artefact, before Lock Lab moves
    // off the standard number — and the alternate must stand on its own price
    // too, so a long line is never recommended purely by comparison.
    const ownEdge = input.winProb - impliedProbability(input.price);
    const worthIt = valueDelta >= 0.01 && ownEdge > 0;
    const keyText = input.keysCrossed.length
      ? ` Crosses the key number ${input.keysCrossed.join(" and ")}.`
      : "";
    const note =
      `${input.describe}: cash chance ${pts(probGain)}, price costs ${pts(priceCost)} of break-even, ` +
      `net ${pts(valueDelta)}.${keyText} ${
        worthIt
          ? "The extra protection is worth the extra juice."
          : "The extra juice is more expensive than the points are worth — the standard line is the better side."
      }`;
    const { describe: _describe, ...rest } = input;
    return { ...rest, probGain, priceCost, valueDelta, worthIt, note };
  }

  /** Dispatch for a provider offer; null when the market has no standard line to compare with. */
  function evaluateOffer(offer: {
    market: string;
    selection: string;
    point: number | null;
    price: number;
  }): AltEvaluation | null {
    if (offer.point == null) return null;
    if (offer.market === "alternate_spreads") return evaluateSpread(offer.selection, offer.point, offer.price);
    if (offer.market === "alternate_totals") return evaluateTotal(offer.selection, offer.point, offer.price);
    return null;
  }

  return { evaluateSpread, evaluateTotal, evaluateOffer };
}

/** Board-level summary of where alternate-line value does (or does not) exist. */
export function summariseAltValue(evaluations: AltEvaluation[]): string[] {
  if (!evaluations.length) {
    return [
      "No alternate spreads or totals are posted for this game, so the standard lines are the only spread/total options.",
    ];
  }
  const notes: string[] = [];
  const bestBySide = new Map<string, AltEvaluation>();
  for (const evaluation of evaluations) {
    const id = `${evaluation.market}:${evaluation.side}`;
    const current = bestBySide.get(id);
    if (!current || evaluation.valueDelta > current.valueDelta) bestBySide.set(id, evaluation);
  }
  for (const best of bestBySide.values()) {
    notes.push(
      best.worthIt
        ? `Alternate-line value: ${best.note}`
        : `Alternate lines checked on ${best.market === "spread" ? best.side : `the ${best.side}`}: the best of them still loses to the standard number. ${best.note}`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Probability / price / expected value
// ---------------------------------------------------------------------------

/** Profit on a $1 stake at American odds. */
export function netProfit(american: number): number {
  return american > 0 ? american / 100 : 100 / Math.abs(american);
}

/** Expected value per $1 staked at an estimated win probability. */
export function expectedValue(probability: number, american: number): number {
  return probability * netProfit(american) - (1 - probability);
}

export type ValueGroup = "core" | "alt" | "prop";

/**
 * How much the estimate can be trusted:
 * - "strong": edge clears the full uncertainty band — can be green.
 * - "playable": edge clears half the band with positive EV — yellow at best.
 * - "insufficient": the edge is inside the noise or the EV is negative.
 */
export type ValueTier = "strong" | "playable" | "insufficient";

export type ValueGrade = {
  /** Lock Lab's estimated win probability, or null when nothing supports one. */
  modelProb: number | null;
  impliedProb: number;
  /** modelProb - impliedProb. */
  edge: number | null;
  /** Expected value per $1 staked at the estimated probability. */
  ev: number | null;
  /** How much the probability estimate can be trusted (1 sd, in probability). */
  uncertainty: number;
  /** Edge required for the "strong" tier (one full uncertainty band). */
  requiredEdge: number;
  tier: ValueTier;
  /** Edge measured in uncertainty bands — the risk-adjusted ranking number. */
  valueScore: number | null;
  /** True when the candidate may compete for a top bet at all. */
  qualifies: boolean;
  note: string;
};

/**
 * Continuous tail adjustment. Probability estimates get relatively less reliable
 * the further the price sits from a coin flip, so the uncertainty band widens
 * smoothly with log-odds distance instead of a fixed long-shot wall.
 */
function tailStretch(implied: number): number {
  const p = clampProb(implied);
  const logitDistance = Math.abs(Math.log(p / (1 - p)));
  return 1 + Math.min(0.6, 0.26 * logitDistance);
}

/**
 * Connects price to probability for every candidate.
 *
 * Nothing qualifies on payout: the modelled probability has to beat the implied
 * probability by more than the estimate's own error. That error grows gradually
 * with price length, alternate distance and weak matchup evidence rather than
 * through a single blunt long-shot penalty.
 */
export function gradeValue(input: {
  modelProb: number | null;
  price: number;
  group: ValueGroup;
  /** Points away from the standard line, for alternates. */
  distance?: number;
  /** 0-1 confidence in the matchup evidence behind the estimate (default 0.5). */
  evidenceStrength?: number;
}): ValueGrade {
  const implied = impliedProbability(input.price);
  const distance = Math.abs(input.distance ?? 0);
  const base = input.group === "core" ? 0.025 : input.group === "prop" ? 0.042 : 0.03;
  const evidence = Math.min(1, Math.max(0, input.evidenceStrength ?? 0.5));
  // Weak evidence widens the band by up to 25%, strong evidence narrows it by 25%.
  const evidenceFactor = 1.25 - 0.5 * evidence;
  const spread = base + (input.group === "alt" ? 0.007 * distance : 0);
  const uncertainty = Math.min(0.14, spread * tailStretch(implied) * evidenceFactor);
  const requiredEdge = uncertainty;

  if (input.modelProb == null) {
    return {
      modelProb: null,
      impliedProb: implied,
      edge: null,
      ev: null,
      uncertainty,
      requiredEdge,
      tier: "insufficient",
      valueScore: null,
      qualifies: false,
      note: `Price implies ${pct(implied)}; no supportable probability estimate for this selection, so it cannot be ranked on value.`,
    };
  }

  const modelProb = clampProb(input.modelProb);
  const edge = modelProb - implied;
  const ev = expectedValue(modelProb, input.price);
  const valueScore = edge / uncertainty;
  // A clear 2-3% edge is playable on its own, even when the candidate's own
  // uncertainty band happens to be wider than that.
  const playableEdge = Math.min(0.4 * requiredEdge, 0.02);
  const tier: ValueTier =
    (edge >= requiredEdge || edge >= 0.05) && ev > 0
      ? "strong"
      : edge >= playableEdge && ev > 0.002
        ? "playable"
        : "insufficient";
  return {
    modelProb,
    impliedProb: implied,
    edge,
    ev,
    uncertainty,
    requiredEdge,
    tier,
    valueScore,
    qualifies: tier !== "insufficient",
    note:
      `Estimated win chance ${pct(modelProb)} vs implied ${pct(implied)} at ${input.price} ` +
      `(edge ${pts(edge)}, EV ${ev >= 0 ? "+" : ""}${ev.toFixed(3)} per $1, ` +
      `uncertainty ±${pts(uncertainty)}, risk-adjusted ${valueScore.toFixed(2)} bands). ` +
      (tier === "strong"
        ? "Edge clears the full uncertainty band: supportable as a strong bet."
        : tier === "playable"
          ? "Edge clears half the uncertainty band with positive expectation: playable, but the estimate carries real doubt."
          : ev > 0
            ? "Positive on paper but well inside the uncertainty band — not a supported edge."
            : "Negative expectation at this price: the payout does not make up for how often it loses."),
  };
}

/**
 * How reliable the probability estimate behind a candidate is, independent of
 * how large its edge looks. Props, long prices, alternates that sell protection
 * and one-sided markets all estimate worse, so their raw value is discounted
 * before anything is ranked.
 */
export function robustnessScore(input: {
  grade: ValueGrade;
  group: ValueGroup;
  /** Win-probability gained (+) or surrendered (-) versus the standard line. */
  probGain?: number | null;
  keysCrossed?: number;
  /** True when the book posts a price on both sides of this market. */
  hasOpposite?: boolean;
}): number {
  let r = 1;
  if (input.group === "prop") r *= 0.8;
  else if (input.group === "alt") r *= 0.9;

  const implied = input.grade.impliedProb;
  // Continuous: the further below a coin flip the price sits, the less the
  // estimate can be trusted. No cliff, no ban.
  if (implied < 0.45) r *= 0.6 + 0.4 * (implied / 0.45);

  const gain = input.probGain ?? 0;
  // Selling protection (fewer points for a bigger payout) is the least robust
  // alternate there is: it leans entirely on the modelled margin distribution.
  if (gain < 0) r *= 1 - Math.min(0.4, Math.abs(gain) * 2.2);
  else if ((input.keysCrossed ?? 0) > 0) r *= 1.05;

  if (input.hasOpposite === false) r *= 0.85;
  return Math.max(0.1, Math.min(1, r));
}

/** Edge in uncertainty bands, discounted by how reliable the estimate is. */
export function riskAdjustedScore(grade: ValueGrade, robustness: number): number {
  return (grade.valueScore ?? 0) * robustness;
}

/**
 * Whether a candidate may hold the #1 slot.
 *
 * A full-band edge ("strong"/GREEN) leads on its own. A partial-band edge
 * ("playable"/YELLOW) is a publishable rating and is allowed to lead too, as
 * long as the estimate behind it is not fragile. Long prices are not banned,
 * but they must be close to a full-band edge with a robust estimate before they
 * can lead, so payout alone never buys the top slot.
 */
export function canLeadBoard(
  grade: ValueGrade,
  robustness: number,
): { ok: boolean; why: string } {
  if (grade.tier === "strong") return { ok: true, why: "" };
  if (grade.tier === "insufficient") {
    return { ok: false, why: "the edge sits inside the model's uncertainty band" };
  }
  const score = grade.valueScore ?? 0;
  if (grade.impliedProb < 0.4) {
    // Long price: needs a near-full band edge and a reliable estimate to lead.
    if (score >= 0.9 && robustness >= 0.8) return { ok: true, why: "" };
    return {
      ok: false,
      why: "the edge clears only part of the uncertainty band at a long price, which needs unusually strong support to lead the board",
    };
  }
  if (robustness < 0.55) {
    return {
      ok: false,
      why: "the edge clears only part of the uncertainty band and the estimate behind it rests on one fragile assumption",
    };
  }
  return { ok: true, why: "" };
}

