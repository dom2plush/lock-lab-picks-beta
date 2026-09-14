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
