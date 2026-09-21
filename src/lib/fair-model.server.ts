/**
 * Lock Lab's baseline game model.
 *
 * This runs BEFORE any line shopping. It produces Lock Lab's own fair spread,
 * fair total and fair win probability from team strength, opponent-adjusted
 * results, injuries, rest and the market as a reference point — never from an
 * attractive alternate price.
 *
 * Rules baked in here:
 *  - The market is the anchor, not the answer. The model may move off it, but
 *    only by a bounded amount and only in proportion to how much real evidence
 *    exists.
 *  - One result cannot carry a rating. Ratings are opponent-adjusted averages
 *    shrunk toward the league mean by sample size, so Week 1 matters without
 *    overpowering established strength.
 *  - Market-context signals (perception gap, key numbers, recency, movement)
 *    are NOT inputs here. They are commentary handed to the handicap read and
 *    can never move the fair line.
 *  - Nothing is invented. With no stored results the fair line is simply the
 *    market line, and the model says so.
 */
import type { GameOdds, GameRow, Injury, Sport } from "./lock-lab-types";

/** Home-field value in points. */
const HOME_FIELD: Record<Sport, number> = { NFL: 1.8, CFB: 2.4 };
/** Hardest the model may ever disagree with the posted spread. */
const MAX_SPREAD_DEVIATION: Record<Sport, number> = { NFL: 3, CFB: 4 };
/** Hardest the model may ever disagree with the posted total. */
const MAX_TOTAL_DEVIATION: Record<Sport, number> = { NFL: 4, CFB: 5 };
/** Share of the model-vs-market gap the model is allowed to claim at full confidence. */
const MODEL_WEIGHT = 0.35;
/** Games of results needed before the model is trusted at full weight. */
const CONFIDENCE_GAMES = 4;
/** Shrinkage constant: ratings pull toward league average until the sample grows. */
const SHRINK = 3;
/** Points charged for a quarterback ruled out; other contributors are worth far less. */
const QB_OUT_POINTS: Record<Sport, number> = { NFL: 4.5, CFB: 4 };

type FinalGame = {
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  commence_time: string;
};

export type TeamRating = {
  team: string;
  games: number;
  /** Opponent-adjusted points better (or worse) than an average team. */
  rating: number;
  /** Points scored per game. */
  pointsFor: number;
  /** Points allowed per game. */
  pointsAgainst: number;
  lastPlayed: string | null;
};

export type GameProjectionInputs = {
  /** Lock Lab's own expected home margin, before blending with the market. */
  modelMargin: number | null;
  /** Lock Lab's own expected combined score, before blending with the market. */
  modelTotal: number | null;
  marketMargin: number | null;
  marketTotal: number | null;
  home: TeamRating | null;
  away: TeamRating | null;
  injuryAdjustment: number;
  restAdjustment: number;
  /** 0-1: how much real evidence sits behind the model numbers. */
  confidence: number;
};

export type FairModel = {
  /** Fair home margin (positive = home favoured). Null when there is no market and no ratings. */
  fairMargin: number | null;
  /** Fair combined score. */
  fairTotal: number | null;
  inputs: GameProjectionInputs;
  /** Plain-language record of how the fair line was reached. */
  notes: string[];
};

function isFinal(row: {
  home_score: number | null;
  away_score: number | null;
}): row is { home_score: number; away_score: number } {
  return row.home_score != null && row.away_score != null;
}

/**
 * Two-pass opponent adjustment. A team's rating is its average scoring margin
 * with home field removed, corrected by the strength of the teams it played.
 * Shrinkage toward zero keeps a one-game sample from producing a huge rating.
 */
function buildRatings(finals: FinalGame[], sport: Sport): Map<string, TeamRating> {
  const hfa = HOME_FIELD[sport];
  type Acc = {
    margins: { margin: number; opponent: string }[];
    pf: number;
    pa: number;
    last: string | null;
  };
  const acc = new Map<string, Acc>();
  const touch = (team: string): Acc => {
    let entry = acc.get(team);
    if (!entry) {
      entry = { margins: [], pf: 0, pa: 0, last: null };
      acc.set(team, entry);
    }
    return entry;
  };

  for (const game of finals) {
    const margin = game.home_score - game.away_score;
    const home = touch(game.home_team);
    const away = touch(game.away_team);
    // Neutralise home field so ratings describe team strength, not venue.
    home.margins.push({ margin: margin - hfa, opponent: game.away_team });
    away.margins.push({ margin: -margin + hfa, opponent: game.home_team });
    home.pf += game.home_score;
    home.pa += game.away_score;
    away.pf += game.away_score;
    away.pa += game.home_score;
    if (!home.last || game.commence_time > home.last) home.last = game.commence_time;
    if (!away.last || game.commence_time > away.last) away.last = game.commence_time;
  }

  let ratings = new Map<string, number>();
  for (const [team, entry] of acc) {
    const raw = entry.margins.reduce((sum, m) => sum + m.margin, 0) / entry.margins.length;
    ratings.set(team, (raw * entry.margins.length) / (entry.margins.length + SHRINK));
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const next = new Map<string, number>();
    for (const [team, entry] of acc) {
      const adjusted =
        entry.margins.reduce((sum, m) => sum + m.margin + (ratings.get(m.opponent) ?? 0), 0) /
        entry.margins.length;
      next.set(team, (adjusted * entry.margins.length) / (entry.margins.length + SHRINK));
    }
    ratings = next;
  }

  const out = new Map<string, TeamRating>();
  for (const [team, entry] of acc) {
    out.set(team, {
      team,
      games: entry.margins.length,
      rating: ratings.get(team) ?? 0,
      pointsFor: entry.pf / entry.margins.length,
      pointsAgainst: entry.pa / entry.margins.length,
      lastPlayed: entry.last,
    });
  }
  return out;
}

/**
 * Availability cost in points. Only the supplied injury report is used, and a
 * player's absence from it is never read as evidence of anything.
 */
function injuryPoints(injuries: Injury[], team: string, sport: Sport): number {
  let points = 0;
  let others = 0;
  for (const injury of injuries) {
    if (injury.team !== team) continue;
    const status = injury.status.toLowerCase();
    const out = /out|doubtful|injured reserve|\bir\b|suspend/.test(status);
    if (!out) continue;
    const isQb = /\bqb\b|quarterback/i.test(`${injury.player} ${injury.note ?? ""}`);
    if (isQb) points += QB_OUT_POINTS[sport];
    else others += 0.35;
  }
  return points + Math.min(others, 1.5);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Builds the fair line. Any failure to read stored results falls back to the
 * market anchor and says so, rather than guessing at team strength.
 */
export async function buildFairModel(game: GameRow, odds: GameOdds): Promise<FairModel> {
  const marketMargin = odds.spread ? -odds.spread.home : null;
  const marketTotal = odds.total ? odds.total.points : null;
  const notes: string[] = [];

  let ratings = new Map<string, TeamRating>();
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("games")
      .select("home_team, away_team, home_score, away_score, commence_time")
      .eq("sport", game.sport)
      .eq("is_demo", false)
      .lt("commence_time", game.commence_time)
      .not("home_score", "is", null)
      .not("away_score", "is", null)
      .order("commence_time", { ascending: false })
      .limit(600);
    if (error) throw error;
    ratings = buildRatings((data ?? []).filter(isFinal) as FinalGame[], game.sport);
  } catch (err) {
    console.error("Lock Lab fair model: stored results unavailable", err);
  }

  const home = ratings.get(game.home_team) ?? null;
  const away = ratings.get(game.away_team) ?? null;

  const injuryAdjustment =
    injuryPoints(game.injuries ?? [], game.away_team, game.sport) -
    injuryPoints(game.injuries ?? [], game.home_team, game.sport);

  let restAdjustment = 0;
  if (home?.lastPlayed && away?.lastPlayed) {
    const homeRest = daysBetween(game.commence_time, home.lastPlayed);
    const awayRest = daysBetween(game.commence_time, away.lastPlayed);
    // A day of extra rest is worth a fraction of a point, capped hard.
    restAdjustment = Math.max(-0.8, Math.min(0.8, (homeRest - awayRest) * 0.1));
  }

  let modelMargin: number | null = null;
  let modelTotal: number | null = null;
  let confidence = 0;

  if (home && away) {
    confidence = Math.min(1, Math.min(home.games, away.games) / CONFIDENCE_GAMES);
    modelMargin =
      home.rating - away.rating + HOME_FIELD[game.sport] + injuryAdjustment + restAdjustment;
    modelTotal = (home.pointsFor + away.pointsAgainst) / 2 + (away.pointsFor + home.pointsAgainst) / 2;
    notes.push(
      `Team strength (opponent-adjusted, shrunk for sample size): ${game.home_team} ${round1(home.rating)} over ${home.games} game${home.games === 1 ? "" : "s"}, ${game.away_team} ${round1(away.rating)} over ${away.games}.`,
      `Model expectation before the market: ${round1(modelMargin)} home margin, ${round1(modelTotal)} combined points (home field ${HOME_FIELD[game.sport]}, injuries ${round1(injuryAdjustment)}, rest ${round1(restAdjustment)}).`,
    );
  } else {
    notes.push(
      "TEAM STRENGTH UNAVAILABLE: not enough stored completed results for these teams, so the fair line is the posted market line. No team-strength deviation is claimed.",
    );
  }

  const weight = MODEL_WEIGHT * confidence;

  let fairMargin: number | null = marketMargin;
  if (marketMargin != null && modelMargin != null) {
    const gap = modelMargin - marketMargin;
    const deviation = Math.max(
      -MAX_SPREAD_DEVIATION[game.sport],
      Math.min(MAX_SPREAD_DEVIATION[game.sport], gap * weight),
    );
    fairMargin = marketMargin + deviation;
    notes.push(
      `Fair spread: market has ${round1(marketMargin)}, the model has ${round1(modelMargin)}; at ${(weight * 100).toFixed(0)}% model weight (capped at ${MAX_SPREAD_DEVIATION[game.sport]} points) the fair home margin is ${round1(fairMargin)}.`,
    );
  } else if (marketMargin == null) {
    fairMargin = modelMargin;
  }

  let fairTotal: number | null = marketTotal;
  if (marketTotal != null && modelTotal != null) {
    const gap = modelTotal - marketTotal;
    const deviation = Math.max(
      -MAX_TOTAL_DEVIATION[game.sport],
      Math.min(MAX_TOTAL_DEVIATION[game.sport], gap * weight),
    );
    fairTotal = marketTotal + deviation;
    notes.push(
      `Fair total: market has ${marketTotal}, the model has ${round1(modelTotal)}; fair total ${round1(fairTotal)}.`,
    );
  } else if (marketTotal == null) {
    fairTotal = modelTotal;
  }

  return {
    fairMargin,
    fairTotal,
    inputs: {
      modelMargin,
      modelTotal,
      marketMargin,
      marketTotal,
      home,
      away,
      injuryAdjustment,
      restAdjustment,
      confidence,
    },
    notes,
  };
}
