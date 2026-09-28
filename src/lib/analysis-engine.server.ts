/**
 * The Lock Lab formula.
 *
 * Two layers, in this order:
 *
 *  1. MARKET FIRST (market-math.server.ts) — the posted spread, total,
 *     moneyline, alternates and props are turned into vig-free probabilities,
 *     hold, key-number reads and internal mispricings. The market is the prior;
 *     it is only faded for a measurable reason surfaced here.
 *  2. HANDICAP PASS — a structured model read that works the Lock Lab pillars
 *     in order (QB, trenches, skill players, defense, game script, injuries)
 *     and must select from the real posted board. It can return nothing.
 *
 * Hard rules enforced in code, not left to the model:
 *  - Every pick's line, price, book and timestamp are copied from the live
 *    odds snapshot. A selection the model invents is discarded.
 *  - A priced pregame board is ranked to exactly two distinct top selections;
 *    low-edge selections are marked red rather than presented as strong bets.
 *  - Same game + same snapshot = same result for every user.
 */
import type {
  AnalysisRow,
  Badge,
  GameOdds,
  GameRow,
  MarketOffer,
  PickBet,
  PropBet,
} from "./lock-lab-types";
import type { AltEvaluation, ValueGrade } from "./market-math.server";
import {
  alternateSpreadRule,
  FOOTBALL_KEY_MARGINS,
  createAltEvaluator,
  devig,
  gradeValue,
  keyNumberGate,
  robustnessScore,
  riskAdjustedScore,
  canLeadBoard,
  impliedProbability,
  readMarket,
  summariseAltValue,
} from "./market-math.server";
import { readMarketContext } from "./market-context.server";
import { buildFairModel } from "./fair-model.server";
import type { GameProjection } from "./game-sim.server";
import { simulateGame } from "./game-sim.server";
import type { PlayerProjection } from "./player-sim.server";
import { simulatePlayers } from "./player-sim.server";

const BADGES: Badge[] = ["green", "yellow", "red"];

function fmtOdds(price: number | undefined | null): string {
  if (price == null) return "";
  return price > 0 ? `+${price}` : `${price}`;
}

function fmtLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

const PROP_MARKET_LABEL: Record<string, string> = {
  player_pass_yds: "Passing yards",
  player_pass_tds: "Passing TDs",
  player_pass_completions: "Pass completions",
  player_pass_attempts: "Pass attempts",
  player_pass_interceptions: "Interceptions thrown",
  player_rush_yds: "Rushing yards",
  player_rush_attempts: "Rush attempts",
  player_reception_yds: "Receiving yards",
  player_receptions: "Receptions",
  player_1st_td: "First TD scorer",
  player_anytime_td: "Anytime TD",
  player_tds_over: "Player TDs",
};

/**
 * How far a posted prop rung may sit from that player's main number before the
 * board refuses to consider it. Large bumps manufacture value out of variance,
 * so they are never evaluated, even when the sportsbook posts them.
 */
const PROP_BUMP_LIMIT: Record<string, number> = {
  player_pass_yds: 25,
  player_rush_yds: 10,
  player_reception_yds: 10,
  player_receptions: 1,
  player_pass_completions: 2,
  player_pass_attempts: 3,
  player_rush_attempts: 2,
  player_carries: 2,
};

/** The player's main number: the median posted rung, always a real posted line. */
function medianPoint(points: number[]): number {
  const sorted = [...points].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Drops prop rungs that sit further from the player's main number than the
 * allowed bump. Markets without a numeric line (touchdown scorers) pass
 * through untouched.
 */
export function limitPropBumps(offers: MarketOffer[]): MarketOffer[] {
  const ladders = new Map<string, number[]>();
  for (const offer of offers) {
    const limit = PROP_BUMP_LIMIT[offer.market];
    if (limit == null || offer.point == null || !offer.player) continue;
    const key = `${offer.market}|${offer.player}`;
    ladders.set(key, [...(ladders.get(key) ?? []), offer.point]);
  }
  const base = new Map<string, number>();
  for (const [key, points] of ladders) base.set(key, medianPoint(points));

  return offers.filter((offer) => {
    const limit = PROP_BUMP_LIMIT[offer.market];
    if (limit == null || offer.point == null || !offer.player) return true;
    const main = base.get(`${offer.market}|${offer.player}`);
    return main == null || Math.abs(offer.point - main) <= limit;
  });
}

const ALT_MARKET_LABEL: Record<string, string> = {
  alternate_spreads: "Alternate spread",
  alternate_totals: "Alternate total",
  team_totals: "Team total",
};

/** One real, postable selection from the live board. */
type Candidate = {
  key: string;
  group: "core" | "alt" | "prop";
  market: string;
  marketLabel: string;
  selection: string;
  player?: string;
  label: string;
  line: string | null;
  point: number | null;
  price: number;
  book: string;
  bookKey: string | null;
  capturedAt: string | null;
  /** Quant context for this exact selection (fair price, hold, key numbers). */
  note: string;
  /** Standard-vs-alternate grade, present only on alternate spread/total lines. */
  alt?: AltEvaluation;
  /** Probability read straight from the 100 simulated games, when available. */
  simProb?: number;
  /** Key of the standard-market candidate this alternate is measured against. */
  standardKey?: string;
  /** Probability vs price: estimated chance, implied chance, edge, EV, noise band. */
  grade?: ValueGrade;
};

/** Internal calibration record for one considered selection. Never rendered publicly. */
export type CandidateAuditEntry = {
  key: string;
  label: string;
  market: string;
  group: "core" | "alt" | "prop";
  kind: "standard" | "alternate" | "prop";
  book: string;
  line: string | null;
  price: number;
  estimatedProb: number | null;
  impliedProb: number;
  edge: number | null;
  ev: number | null;
  uncertainty: number;
  requiredEdge: number;
  /** "strong" | "playable" | "insufficient" under the calibrated bands. */
  tier: string;
  /** Edge measured in uncertainty bands (risk-adjusted ranking number). */
  valueScore: number | null;
  decision: "green" | "yellow" | "red" | "pass";
  section: "top" | "fun" | "prop" | null;
  reason: string;
  /** Alternate lines only: how this number compares with the standard market. */
  standardLine: string | null;
  standardPrice: number | null;
  alternateConsidered: boolean;
  alternateBetterThanStandard: boolean | null;
};

export type CandidateAudit = {
  generatedAt: string;
  /** The game this board belongs to — proves the trail is not shared. */
  gameId: string | null;
  providerGameId: string | null;
  snapshotBook: string | null;
  snapshotCapturedAt: string | null;
  altMarketsSupplied: number;
  propMarketsSupplied: number;
  /** Standard spread/total/moneyline selections graded on this run. */
  standardMarketsEvaluated: number;
  /** Alternate prices received from the sportsbook feed. */
  alternateMarketsReceived: number;
  /** Alternate ladder rungs graded against their standard line on this run. */
  alternateMarketsEvaluated: number;
  /** Sportsbooks that supplied the alternate rungs actually graded. */
  alternateBooks: string[];
  /** Every graded rung, cheapest line first — the ladder the engine really saw. */
  ladder: { market: string; side: string; line: string | null; price: number; book: string }[];
  /** The best-graded candidate of any kind on the board. */
  bestCandidate: CandidateAuditEntry | null;
  /** The single best-graded alternate rung considered. */
  strongestAlternate: CandidateAuditEntry | null;
  /** Why that alternate was selected or rejected. */
  strongestAlternateOutcome: string;
  /** Best rung's risk-adjusted score minus its standard line's, or null. */
  standardVsAlternateEdge: number | null;
  entries: CandidateAuditEntry[];
  /** Highest-edge candidate that was considered and not published. */
  strongestRejected: CandidateAuditEntry | null;
};


export type EngineOutput = {
  topBets: PickBet[];
  /** Legacy storage field. Separate Fun Bets are no longer produced. */
  funBets: [];
  playerProps: PropBet[];
  notes: {
    propsAvailable: boolean;
    altMarketsAvailable: boolean;
    /** Set when Lock Lab is deliberately passing on the board. */
    verdict: string | null;
  };
  /** Developer-only calibration trail; not part of the public output. */
  candidateAudit: CandidateAudit;
};

/** Real provider prices for derivative markets. Empty = market unavailable. */
export type ExtraOffers = { alternates: MarketOffer[]; props: MarketOffer[] };

function teamTag(game: GameRow, team: string) {
  if (team === game.home_team) return game.home_team_short ?? game.home_team;
  if (team === game.away_team) return game.away_team_short ?? game.away_team;
  return team;
}

/**
 * Key-number gate for alternates that buy points: the move must cross a
 * recognised football key number, and the existing 50 simulated games must show
 * it cashes meaningfully more often than the standard line. A failing rung is
 * never treated as better than its standard number.
 */
function applyKeyGate(
  evaluation: AltEvaluation | null,
  game: GameRow,
  projection: GameProjection,
): AltEvaluation | null {
  if (!evaluation) return evaluation;
  const count = (o: boolean[] | null) => (o ? o.filter(Boolean).length : null);
  let standardOutcomes: boolean[] | null = null;
  let altOutcomes: boolean[] | null = null;
  if (evaluation.market === "spread") {
    const side = evaluation.side === game.home_team ? "home" : evaluation.side === game.away_team ? "away" : null;
    if (side) {
      standardOutcomes = projection.spreadOutcomes(side, evaluation.standardPoint);
      altOutcomes = projection.spreadOutcomes(side, evaluation.point);
    }
  } else if (evaluation.side === "Over" || evaluation.side === "Under") {
    standardOutcomes = projection.totalOutcomes(evaluation.side, evaluation.standardPoint);
    altOutcomes = projection.totalOutcomes(evaluation.side, evaluation.point);
  }
  const runs = altOutcomes?.length ?? standardOutcomes?.length ?? 50;
  // Alternate spreads: more protection only, across a real football key margin,
  // at -100 to -180 — or plus money when the simulations back it at 35 of 50.
  if (evaluation.market === "spread") {
    const rule = alternateSpreadRule({
      sport: game.sport,
      standardPoint: evaluation.standardPoint,
      point: evaluation.point,
      price: evaluation.price,
      altHits: count(altOutcomes),
      runs,
    });
    if (!rule.ok) {
      return {
        ...evaluation,
        worthIt: false,
        keyGate: { ok: false, why: rule.why, simGain: null },
        note: `${evaluation.note} ${rule.why}`.trim(),
      };
    }
  }
  const gate = keyNumberGate({
    market: evaluation.market,
    sport: game.sport,
    side: evaluation.side,
    standardPoint: evaluation.standardPoint,
    point: evaluation.point,
    standardHits: count(standardOutcomes),
    altHits: count(altOutcomes),
    runs,
  });
  if (gate.ok && !gate.why) return evaluation;
  return {
    ...evaluation,
    worthIt: gate.ok ? evaluation.worthIt : false,
    keyGate: { ok: gate.ok, why: gate.why, simGain: gate.simGain },
    note: `${evaluation.note} ${gate.why}`.trim(),
  };
}

/** True when an alternate buys points without crossing a key number the simulations confirm. */
function failsKeyGate(c: Candidate): boolean {
  return Boolean(c.alt?.keyGate && !c.alt.keyGate.ok);
}

/** An alternate must match or beat its own standard line's edge before it can replace it. */
function beatsStandardEdge(alt: Candidate, standard: Candidate | undefined): boolean {
  if (!standard?.grade || standard.grade.edge == null) return true;
  return (alt.grade?.edge ?? -Infinity) >= standard.grade.edge;
}

export function buildCandidates(
  game: GameRow,
  odds: GameOdds,
  extra: ExtraOffers,
  projection: GameProjection,
  players: PlayerProjection,
): Candidate[] {
  const out: Candidate[] = [];
  const book = odds.bookmaker ?? "consensus";
  const bookKey = odds.bookmakerKey ?? null;
  const capturedAt = odds.capturedAt ?? game.odds_updated_at ?? null;
  const home = teamTag(game, game.home_team);
  const away = teamTag(game, game.away_team);

  if (odds.spread) {
    const { homePrice, awayPrice } = odds.spread;
    const fair = devig(homePrice, awayPrice);
    out.push({
      key: "spread-home",
      group: "core",
      market: "spread",
      marketLabel: "Spread",
      selection: game.home_team,
      label: `${home} ${fmtLine(odds.spread.home)} (${fmtOdds(homePrice)})`,
      line: fmtLine(odds.spread.home),
      point: odds.spread.home,
      price: homePrice,
      book,
      bookKey,
      capturedAt,
      note: `vig-free cover chance ${(fair.a * 100).toFixed(1)}%`,
    });
    out.push({
      key: "spread-away",
      group: "core",
      market: "spread",
      marketLabel: "Spread",
      selection: game.away_team,
      label: `${away} ${fmtLine(odds.spread.away)} (${fmtOdds(awayPrice)})`,
      line: fmtLine(odds.spread.away),
      point: odds.spread.away,
      price: awayPrice,
      book,
      bookKey,
      capturedAt,
      note: `vig-free cover chance ${(fair.b * 100).toFixed(1)}%`,
    });
  }

  if (odds.total) {
    const { overPrice, underPrice, points } = odds.total;
    const fair = devig(overPrice, underPrice);
    out.push({
      key: "total-over",
      group: "core",
      market: "total",
      marketLabel: "Total",
      selection: "Over",
      label: `Over ${points} (${fmtOdds(overPrice)})`,
      line: String(points),
      point: points,
      price: overPrice,
      book,
      bookKey,
      capturedAt,
      note: `vig-free Over chance ${(fair.a * 100).toFixed(1)}%`,
    });
    out.push({
      key: "total-under",
      group: "core",
      market: "total",
      marketLabel: "Total",
      selection: "Under",
      label: `Under ${points} (${fmtOdds(underPrice)})`,
      line: String(points),
      point: points,
      price: underPrice,
      book,
      bookKey,
      capturedAt,
      note: `vig-free Under chance ${(fair.b * 100).toFixed(1)}%`,
    });
  }

  if (odds.moneyline) {
    const fair = devig(odds.moneyline.home, odds.moneyline.away);
    out.push({
      key: "ml-home",
      group: "core",
      market: "moneyline",
      marketLabel: "Moneyline",
      selection: game.home_team,
      label: `${home} ML (${fmtOdds(odds.moneyline.home)})`,
      line: null,
      point: null,
      price: odds.moneyline.home,
      book,
      bookKey,
      capturedAt,
      note: `vig-free win chance ${(fair.a * 100).toFixed(1)}%`,
    });
    out.push({
      key: "ml-away",
      group: "core",
      market: "moneyline",
      marketLabel: "Moneyline",
      selection: game.away_team,
      label: `${away} ML (${fmtOdds(odds.moneyline.away)})`,
      line: null,
      point: null,
      price: odds.moneyline.away,
      book,
      bookKey,
      capturedAt,
      note: `vig-free win chance ${(fair.b * 100).toFixed(1)}%`,
    });
  }

  // Alternate lines and team totals. Every alternate is graded against the
  // standard line of the same market before it reaches the board, and the
  // sharpest ones are kept — not simply the ones with the most points.
  const evaluator = createAltEvaluator(odds, game.sport, {
    home: game.home_team,
    away: game.away_team,
  });
  const standardKeyFor = (market: string, selection: string): string | undefined => {
    if (market === "alternate_spreads") {
      return selection === game.home_team ? "spread-home" : selection === game.away_team ? "spread-away" : undefined;
    }
    if (market === "alternate_totals") {
      return selection === "Over" ? "total-over" : selection === "Under" ? "total-under" : undefined;
    }
    return undefined;
  };

  // Every posted rung is graded. The price window only excludes quotes no one
  // can sensibly bet (deep buy-outs and lottery numbers); it is not a value
  // filter — value is decided later, on probability against price.
  type ScoredAlt = { offer: MarketOffer; evaluation: AltEvaluation | null };
  const scored: ScoredAlt[] = extra.alternates
    .filter((o) => o.point != null && o.price <= 1200 && o.price >= -1000)
    // An alternate spread must name one of the two teams exactly; anything
    // else could be mistaken for the other side's number.
    .filter(
      (o) => o.market !== "alternate_spreads" || o.selection === game.home_team || o.selection === game.away_team,
    )
    .map((offer) => ({ offer, evaluation: applyKeyGate(evaluator.evaluateOffer(offer), game, projection) }));

  // Both rungs of the ladder matter: the cap is per market AND per side, so a
  // long favourite ladder can never crowd the other side's numbers off the board.
  const perLadder = new Map<string, number>();
  const ordered = scored.slice().sort((a, b) => {
    if (a.offer.market !== b.offer.market) return a.offer.market.localeCompare(b.offer.market);
    const av = a.evaluation?.valueDelta ?? -Infinity;
    const bv = b.evaluation?.valueDelta ?? -Infinity;
    if (av !== bv) return bv - av;
    return (a.offer.point ?? 0) - (b.offer.point ?? 0);
  });

  ordered.forEach(({ offer, evaluation }, index) => {
    const ladder = `${offer.market}|${offer.player ?? offer.selection}`;
    // Rungs inside the allowed alternate distance (e.g. +7.5 next to a +7
    // standard) are always graded; only far-off rungs count toward the cap.
    const inRange =
      evaluation != null &&
      Math.abs(evaluation.point - evaluation.standardPoint) <= (MAX_ALT_DISTANCE[evaluation.market] ?? 3);
    const count = perLadder.get(ladder) ?? 0;
    if (!inRange && count >= 24) return;
    if (!inRange) perLadder.set(ladder, count + 1);


    const standardKey = standardKeyFor(offer.market, offer.selection);
    out.push({
      key: `alt-${index}`,
      group: "alt",
      market: offer.market,
      marketLabel: ALT_MARKET_LABEL[offer.market] ?? offer.market,
      selection: offer.selection,
      ...(offer.player ? { player: offer.player } : {}),
      label: `${offer.player ? `${teamTag(game, offer.player)} ` : ""}${
        offer.selection === "Over" || offer.selection === "Under"
          ? `${offer.selection} ${offer.point}`
          : `${teamTag(game, offer.selection)} ${fmtLine(offer.point ?? 0)}`
      } (${fmtOdds(offer.price)})`,
      line: offer.point != null ? String(offer.point) : null,
      point: offer.point,
      price: offer.price,
      book: offer.book,
      bookKey: offer.bookKey ?? null,
      capturedAt: offer.capturedAt,
      ...(evaluation ? { alt: evaluation } : {}),
      ...(standardKey ? { standardKey } : {}),
      note: evaluation
        ? evaluation.note
        : `${ALT_MARKET_LABEL[offer.market] ?? offer.market} posted at ${offer.book}`,
    });
  });

  // Player props: only real, verified sides from the posted board.
  const seen = new Set<string>();
  let propCount = 0;
  const perMarket = new Map<string, number>();
  // Touchdown-scorer markets are read first so the per-game prop budget can
  // never cut them off before the TD Scorers section gets a look at them. The per-market
  // budget then guarantees the yardage and reception markets are graded too,
  // instead of a long scorer list swallowing the whole board.
  const propOffers = limitPropBumps(extra.props).sort(
    (a, b) => propMarketPriority(a.market) - propMarketPriority(b.market),
  );
  propOffers.forEach((offer, index) => {
    const side = offer.selection.toLowerCase();
    if (!["over", "under", "yes", "no"].includes(side)) return;
    if (!offer.player) return;
    // Player TD rungs (Over 0.5 / 1.5 / 2.5) are distinct bets, so each posted
    // rung is kept; every other market keeps one rung per player and side.
    const id =
      offer.market === "player_tds_over"
        ? `${offer.market}:${offer.player}:${side}:${offer.point}`
        : `${offer.market}:${offer.player}:${side}`;
    if (seen.has(id) || propCount >= 400) return;
    const marketCount = perMarket.get(offer.market) ?? 0;
    if (marketCount >= 30) return;
    perMarket.set(offer.market, marketCount + 1);
    seen.add(id);
    propCount += 1;
    const marketLabel = PROP_MARKET_LABEL[offer.market] ?? offer.market;
    const sideText =
      offer.point != null
        ? ` ${offer.selection} ${offer.point}`
        : side === "no"
          ? " (No)"
          : "";
    out.push({
      key: `prop-${index}`,
      group: "prop",
      market: offer.market,
      marketLabel,
      selection: offer.selection,
      player: offer.player,
      label: `${offer.player} ${marketLabel}${sideText} (${fmtOdds(offer.price)})`,
      line: offer.point != null ? String(offer.point) : null,
      point: offer.point,
      price: offer.price,
      book: offer.book,
      bookKey: offer.bookKey ?? null,
      capturedAt: offer.capturedAt,
      note: `${marketLabel} posted at ${offer.book}`,
    });
  });

  gradeBoard(out, game, projection, players);
  return out;
}

/**
 * ONE probability source for the whole board.
 *
 * Every spread, total and moneyline price — standard or alternate, either side
 * — is graded against the same 100 simulated final scores produced from Lock
 * Lab's fair line. An alternate therefore cannot be "better" simply because it
 * is further from the market: its probability and the standard line's come
 * from the identical distribution, so the only thing that can separate them is
 * the price.
 *
 * Player props are graded inside those SAME 100 simulated games: each run also
 * produces a stat line for every posted player, correlated with that run's
 * team score and game script, so a prop's probability is the count of runs it
 * cleared. Where a player has no usable simulated stat the posted two-way
 * price is used instead — conservative, never invented — and the same edge and
 * price rules apply either way.
 */
function gradeBoard(
  candidates: Candidate[],
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
) {
  const pairFair = (a: number, b: number) => devig(a, b);
  const sideOf = (team: string): "home" | "away" | null =>
    team === game.home_team ? "home" : team === game.away_team ? "away" : null;

  /** Simulated probability for any spread/total/moneyline selection. */
  const simulated = (c: Candidate): number | null => {
    const market = c.market.toLowerCase();
    if (market.includes("spread")) {
      const side = sideOf(c.selection);
      return side && c.point != null ? projection.spreadProb(side, c.point) : null;
    }
    if (market.includes("total") && !market.includes("team_total")) {
      const side = c.selection === "Over" || c.selection === "Under" ? c.selection : null;
      return side && c.point != null ? projection.totalProb(side, c.point) : null;
    }
    if (market === "moneyline" || market === "h2h") {
      const side = sideOf(c.selection);
      return side ? projection.moneylineProb(side) : null;
    }
    return null;
  };

  // Confidence in the simulated numbers is the model's own confidence: with no
  // stored results behind the fair line, the band stays wide and almost
  // nothing clears it — which is the correct, disciplined outcome.
  const simEvidence = 0.35 + 0.4 * projection.confidence;

  for (const c of candidates) {
    let modelProb: number | null = null;
    let distance = 0;
    let evidence = 0.4;

    const fromSim =
      c.group === "prop"
        ? players.probability({
            market: c.market,
            player: c.player,
            selection: c.selection,
            point: c.point,
          })
        : simulated(c);

    if (fromSim != null) {
      modelProb = fromSim;
      c.simProb = fromSim;
      evidence = simEvidence;
      if (c.alt) distance = Math.abs(c.alt.point - c.alt.standardPoint);
    } else if (c.group === "core") {
      const opposite = candidates.find((x) => x.key === CORE_OPPOSITE[c.key]);
      // No simulated distribution available: fall back to the vig-free market
      // read, which by construction carries no edge of its own.
      modelProb = opposite ? pairFair(c.price, opposite.price).a : impliedProbability(c.price);
      evidence = opposite ? 0.5 : 0.3;
    } else if (c.alt) {
      modelProb = null;
      distance = Math.abs(c.alt.point - c.alt.standardPoint);
    } else if (c.group === "prop") {
      const opposite = findOpposite(c, candidates, game);
      // One-sided prop markets (anytime / first TD) post no mirror price, so the
      // posted price itself is the estimate — conservative, never invented.
      modelProb = opposite ? pairFair(c.price, opposite.price).a : impliedProbability(c.price);
      evidence = opposite ? 0.5 : 0.25;
    }

    c.grade = gradeValue({ modelProb, price: c.price, group: c.group, distance, evidenceStrength: evidence });
    c.note = `${c.note} ${c.grade.note}`;
  }
}

/**
 * Worst price Lock Lab will ever recommend on a Top 2 bet or a player prop.
 * Heavier juice than this is not playable, so it is dropped regardless of edge.
 */
const MIN_RECOMMENDED_PRICE = -180;

/**
 * Longest price allowed in the Top 2. Those two slots are normal bets, so a
 * +200 or longer underdog price never sits there.
 */
const MAX_TOP_PRICE = 199;

/** True when a game price is too long for the Top 2. */
function isLongshotPrice(price: number): boolean {
  return price > MAX_TOP_PRICE;
}

/**
 * THE edge thresholds. Every section — Top 2, props and fallback fills —
 * reads these and nothing else, so a selection can never be playable in one
 * part of the board and a pass in another.
 */
/** Edge Lock Lab is aiming for on a published bet. */
const TARGET_EDGE = 0.01;
/** Absolute floor. Below this the edge is indistinguishable from rounding. */
const MIN_EDGE = 0.005;

/**
 * How far an alternate line may sit from the sportsbook's standard number.
 * Beyond this the price stops being a line-shopping decision and becomes a
 * different bet entirely, which is how artificial value gets manufactured.
 */
const MAX_ALT_DISTANCE: Record<string, number> = { spread: 3, total: 4 };

/**
 * Hard value floor. A selection may only reach the board when Lock Lab's own
 * estimate beats the probability the posted price implies by more than a
 * rounding error. Negative-edge selections are never published, on any path,
 * at any price, in any section.
 */
function hasPositiveEdge(c: Candidate): boolean {
  const g = c.grade;
  if (!g || g.modelProb == null || g.edge == null) return false;
  if (g.ev != null && g.ev <= 0) return false;
  return g.edge >= MIN_EDGE;
}

/**
 * Looser gate for pick #2 and beyond: any positive modelled edge is a
 * legitimate pick. The board light reports how big that edge actually is.
 */
function hasAnyPositiveEdge(c: Candidate): boolean {
  const g = c.grade;
  if (!g || g.modelProb == null || g.edge == null) return false;
  if (g.ev != null && g.ev <= 0) return false;
  return g.edge > 0;
}

/** True when an alternate rung sits further from the standard line than allowed. */
function altTooFar(c: Candidate): boolean {
  if (!c.alt) return false;
  const limit = MAX_ALT_DISTANCE[c.alt.market] ?? 3;
  return Math.abs(c.alt.point - c.alt.standardPoint) > limit;
}

/**
 * Ranking gate for the Top 2. A pick has to be priced below Lock Lab's own
 * estimate of how often it wins — payout size never qualifies a bet. The bar is
 * the candidate's own uncertainty band, which widens gradually with price length
 * and alternate distance, so nothing is rejected by a flat long-shot rule.
 */
function eligibleForTop(c: Candidate): { ok: boolean; why: string } {
  const g = c.grade;
  if (!g) return { ok: true, why: "" };

  // Playability floor: nothing worse than -180 is ever recommended as a Top 2
  // bet or a player prop, however large the modelled edge looks.
  if (c.price < MIN_RECOMMENDED_PRICE) {
    return {
      ok: false,
      why: `${c.label}: priced worse than ${MIN_RECOMMENDED_PRICE} — too heavily juiced to recommend.`,
    };
  }

  // The Top 2 are normal bets. A +200 or longer game price — usually an
  // underdog moneyline — is outside the normal-bet range for these two slots.
  if (c.group !== "prop" && isLongshotPrice(c.price)) {
    return {
      ok: false,
      why: `${c.label}: pays longer than +${MAX_TOP_PRICE} — outside the Top 2 price range.`,
    };
  }

  if (g.modelProb == null) {
    return { ok: false, why: `${c.label}: no supported probability estimate to justify this price.` };
  }

  if (!hasPositiveEdge(c)) {
    return {
      ok: false,
      why: `${c.label}: the simulated win chance does not beat the probability the posted price implies by at least ${(MIN_EDGE * 100).toFixed(1)}% — never recommended.`,
    };
  }

  // An alternate several points off the market is not line shopping, it is a
  // different bet. Distance alone can never be the source of an edge.
  // A bought point that crosses no key number, or that the simulated games do
  // not confirm, is never a Top 2 candidate — however the edge looks on paper.
  if (failsKeyGate(c) && c.alt?.keyGate) {
    return { ok: false, why: `${c.label}: ${c.alt.keyGate.why}` };
  }

  if (altTooFar(c) && c.alt) {
    return {
      ok: false,
      why: `${c.label}: sits more than ${MAX_ALT_DISTANCE[c.alt.market] ?? 3} points off the standard ${c.alt.market} — too far from the market to treat as a line-shopping option.`,
    };
  }

  if (g.tier === "insufficient") {
    return {
      ok: false,
      why: `${c.label}: the estimated edge sits inside the model's own uncertainty band for a price and market of this type.`,
    };
  }

  // An alternate whose juice outruns the protection it buys is only allowed
  // through on a strong edge, or when the miss is marginal and it is genuinely
  // buying points rather than selling them.
  const marginalAlt = c.alt ? c.alt.valueDelta > -0.01 && c.alt.probGain > 0 : false;
  if (c.group === "alt" && c.alt && !c.alt.worthIt && g.tier !== "strong" && !marginalAlt) {
    return {
      ok: false,
      why: `${c.label}: the extra juice costs more than the extra points buy against the standard line, and the edge is not strong enough to override that.`,
    };
  }

  return { ok: true, why: "" };
}

/**
 * Shifts a candidate's probability estimate off the market's vig-free number by
 * the handicap read's stated lean, bounded so a confident-sounding model can
 * never manufacture a large edge out of nothing, then regrades it.
 */
function applyLean(c: Candidate, lean: number | null | undefined, evidence: number | null | undefined): void {
  const g = c.grade;
  if (!g || g.modelProb == null || lean == null || !Number.isFinite(lean)) return;
  const cap = c.group === "prop" ? 5 : 6;
  const shift = Math.max(-cap, Math.min(cap, lean)) / 100;
  if (shift === 0) return;
  const strength = evidence != null && Number.isFinite(evidence) ? Math.max(0, Math.min(1, evidence)) : 0.5;
  // A shakier read both moves the number less and widens its own band.
  const damped = shift * (0.5 + 0.5 * strength);
  c.grade = gradeValue({
    modelProb: g.modelProb + damped,
    price: c.price,
    group: c.group,
    distance: c.alt ? Math.abs(c.alt.point - c.alt.standardPoint) : 0,
    evidenceStrength: strength,
  });
}

/** Apply one supported side read to its standard number and every posted rung on that same side. */
function applySideLean(
  c: Candidate,
  candidates: Candidate[],
  lean: number | null | undefined,
  evidence: number | null | undefined,
): void {
  applyLean(c, lean, evidence);
  if (c.group !== "core") return;
  for (const alternate of candidates) {
    if (alternate.standardKey === c.key) applyLean(alternate, lean, evidence);
  }
}

/** Playable-tier candidates can reach the board, but never as a green bet. */
function capBadge(c: Candidate, badge: Badge): Badge {
  return c.grade?.tier === "playable" && badge === "green" ? "yellow" : badge;
}

/**
 * Red is reserved for a genuinely too-close price. A posted selection the board
 * still leans towards, whose edge simply sits inside the uncertainty band,
 * is published as yellow rather than being written off.
 */
function softBadge(c: Candidate): Badge {
  const g = c.grade;
  if (!g || g.edge == null) return "red";
  if (g.tier === "strong" && g.edge >= TARGET_EDGE) return "green";
  if (g.edge >= TARGET_EDGE) return "yellow";
  if (g.edge >= MIN_EDGE) return "yellow";
  // No measurable edge: the light says so, whatever the price or the payout.
  return "red";
}

/**
 * Two posted prices belong to the same betting idea when they express an opinion
 * on the same question: any rung or side of the game total, and any spread or
 * moneyline on either team (a side bet and its mirror are one idea, not two).
 * The board publishes one bet per idea, so the Top 2 are always two genuinely
 * different opportunities.
 */
function betIdeaKey(c: Candidate): string {
  const market = c.market.toLowerCase();
  const side = `${c.player ?? ""}|${String(c.selection).toLowerCase()}`;
  if (market.includes("team_total")) return `team_total:${side}`;
  if (market.includes("total")) return "total";
  if (market.includes("spread") || market.includes("moneyline") || market === "h2h") {
    return "side";
  }
  return `${market.replace("alternate_", "")}:${side}`;
}

/**
 * Props use the same value logic as the Top 2 — a negative-edge prop is never
 * green anywhere — with the confidence read layered on top of it.
 */
function propBadge(c: Candidate): Badge {
  const g = c.grade;
  if (!g || g.modelProb == null || g.edge == null) return "red";
  if (g.edge < MIN_EDGE) return "red";
  if (g.edge >= TARGET_EDGE && (g.tier === "strong" || g.modelProb >= 0.6)) return "green";
  return "yellow";
}

/**
 * 0 First TD, 1 Anytime TD, 1.5 multi-TD (2+), 2 every non-touchdown market.
 * Anything below 2 is a touchdown market reserved for TD Scorers.
 */
function propMarketPriority(market: string): number {
  return market === "player_1st_td"
    ? 0
    : market === "player_anytime_td"
      ? 1
      : market === "player_tds_over"
        ? 1.5
        : 2;
}

type DecisionMap = Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>;

/**
 * Adds further props ONLY where the board's own probability beats the posted
 * price. Nothing is invented and nothing is padded: a game whose posted props
 * carry no measurable value shows fewer props, or none at all.
 */
function propDirection(c: Candidate): string {
  return (c.selection || "").trim().toLowerCase();
}

/** Closeness window: only a near-equal edge may be preferred for diversity. */
const DIVERSITY_EDGE_TOLERANCE = 0.015;
/** Plus-money props must be genuinely likely, not longshot value. */
const PLUS_MONEY_PROP_MIN_HIT = 0.45;
const propHit = (c: Candidate) => c.grade?.modelProb ?? 0;
/** Props rank by simulated hit probability first; EV only breaks ties. */
const isUnder = (c: Candidate) => propDirection(c).includes("under");
/**
 * Prop strength: simulated hit rate leads; projected volume (a starter-level
 * posted line) and EV support it. Unders need strong simulation support
 * (60%+) or they are marked down, so weak unders are not forced.
 */
const propStrength = (c: Candidate) =>
  propHit(c) +
  (meaningfulPropLine(c) ? 0.06 : 0) +
  0.25 * Math.max(-0.1, Math.min(0.2, c.grade?.edge ?? 0)) -
  (isUnder(c) && propHit(c) < 0.6 ? 0.08 : 0);
const propRankCmp = (a: Candidate, b: Candidate) =>
  propStrength(b) - propStrength(a) || candidateRank(b) - candidateRank(a);
const propPriceOk = (c: Candidate) => c.price < 100 || propHit(c) >= PLUS_MONEY_PROP_MIN_HIT;
/**
 * Minimum posted line that marks a starter/high-usage role in each standard
 * market. A sportsbook's own line is the usage signal: a 12.5-yard receiving
 * line or a 1.5-reception line belongs to a fringe player.
 */
const MEANINGFUL_PROP_LINE: Record<string, number> = {
  player_pass_yds: 150,
  player_pass_completions: 14,
  player_pass_attempts: 20,
  player_pass_tds: 0.5,
  player_rush_yds: 30,
  player_rush_attempts: 8,
  player_reception_yds: 30,
  player_receptions: 2.5,
};
export const meaningfulPropLine = (c: Pick<Candidate, "market" | "point">): boolean => {
  const min = MEANINGFUL_PROP_LINE[c.market];
  return min != null && c.point != null && c.point >= min;
};

function fillPlayerProps(
  candidates: Candidate[],
  used: Set<string>,
  playerProps: PropBet[],
  decisions: DecisionMap,
  maximum = 4,
  reasons?: Map<string, string>,
): void {
  const pool = candidates
    .filter(
      (c) =>
        c.group === "prop" &&
        !used.has(c.key) &&
        c.price >= MIN_RECOMMENDED_PRICE &&
        // Touchdown markets stay reserved for TD Scorers.
        propMarketPriority(c.market) === 2 &&
        c.grade?.modelProb != null &&
        (c.grade?.edge ?? 0) > 0 &&
        (c.grade?.edge ?? 0) >= MIN_EDGE &&
        propPriceOk(c),
    )
    .sort(propRankCmp);
  // Established, high-usage players on meaningful lines lead; fringe players
  // and tiny lines are only used when too few meaningful props qualify.
  // Low-volume players/tiny lines stay only when the simulation strongly backs them.
  const meaningful = pool.filter((c) => meaningfulPropLine(c) || propHit(c) >= 0.65);
  if (meaningful.length >= 4) pool.splice(0, pool.length, ...meaningful);

  const take = (c: Candidate) => {
    const badge = propBadge(c);
    used.add(c.key);
    playerProps.push({
      key: `prop-${playerProps.length + 1}`,
      badge,
      label: c.label,
      player: c.player ?? "",
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      estimatedProbability: c.grade?.modelProb ?? null,
      ...pickSource(c),
      reason:
        reasons?.get(c.key) ??
        "The strongest remaining posted prop on this board under the model's usage and matchup read.",
    });
    decisions.set(c.key, {
      section: "prop",
      badge,
      reason: reasons?.get(c.key) ?? "Player prop from the ranked board.",
    });
  };

  const remaining = pool.filter(
    (c) => !playerProps.some((p) => p.player === (c.player ?? "") && p.market === c.marketLabel),
  );

  while (playerProps.length < maximum && remaining.length) {
    // Hit probability leads: the most likely remaining +EV prop defines the bar.
    const best = remaining[0]!;
    // Contenders are only those whose hit rate is genuinely close to the leader.
    const contenders = remaining.filter((c) => propStrength(c) >= propStrength(best) - DIVERSITY_EDGE_TOLERANCE);

    const chosenPlayers = new Set(playerProps.map((p) => p.player));
    const chosenMarkets = new Set(playerProps.map((p) => p.market));
    const directions = new Set(
      playerProps
        .map((p) => (p.label || "").toLowerCase())
        .map((l) => (l.includes("under") ? "under" : l.includes("over") ? "over" : "")),
    );
    directions.delete("");
    const oneSided = directions.size === 1;
    const currentDirection = [...directions][0];

    const score = (c: Candidate) => {
      let s = 0;
      // Soft preferences only — never enough to beat the tolerance window.
      if (!chosenPlayers.has(c.player ?? "")) s += 2;
      if (!chosenMarkets.has(c.marketLabel)) s += 1;
      if (oneSided && propDirection(c) && propDirection(c) !== currentDirection) s += 3;
      return s;
    };

    let chosen = best;
    if (playerProps.length > 0) {
      chosen = contenders.reduce((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sb > sa) return b;
        if (sb < sa) return a;
        return propRankCmp(a, b) > 0 ? b : a;
      }, contenders[0]!);
    }

    take(chosen);
    const idx = remaining.indexOf(chosen);
    if (idx >= 0) remaining.splice(idx, 1);
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      const c = remaining[i]!;
      if (playerProps.some((p) => p.player === (c.player ?? "") && p.market === c.marketLabel)) {
        remaining.splice(i, 1);
      }
    }
  }

  // Availability floor: when the feed has at least two real posted player
  // markets but fewer than two cleared the edge bar, the strongest remaining
  // ones (by the same 100-run simulated probabilities) are shown with an honest
  // badge rather than reporting props as unavailable. The -180 limit holds,
  // Touchdown markets never enter the standard player-prop floor.
  const MIN_PROPS = 4;
  if (playerProps.length >= MIN_PROPS) return;
  const floor = candidates
    .filter(
      (c) =>
        c.group === "prop" &&
        !used.has(c.key) &&
        c.price >= MIN_RECOMMENDED_PRICE &&
        propMarketPriority(c.market) === 2 &&
        c.grade?.modelProb != null &&
        !playerProps.some((p) => p.player === (c.player ?? "") && p.market === c.marketLabel),
    )
    // Non-touchdown markets first, then by the model's own ranking.
    .sort(
      (a, b) =>
        Number(propMarketPriority(a.market) !== 2) - Number(propMarketPriority(b.market) !== 2) ||
        Number(propPriceOk(b)) - Number(propPriceOk(a)) ||
        Number(meaningfulPropLine(b)) - Number(meaningfulPropLine(a)) ||
        propRankCmp(a, b),
    );
  for (const c of floor) {
    if (playerProps.length >= MIN_PROPS) break;
    if (playerProps.some((p) => p.player === (c.player ?? "") && p.market === c.marketLabel)) continue;
    const thin = (c.grade?.edge ?? 0) < MIN_EDGE;
    const badge: Badge = thin ? "red" : propBadge(c);
    used.add(c.key);
    const reason =
      reasons?.get(c.key) ??
      (thin
        ? "Thin edge — the strongest remaining posted prop in the 100 simulated games, shown so you can compare it; the model sees little value at this price."
        : "The strongest remaining posted prop on this board under the model's usage and matchup read.");
    playerProps.push({
      key: `prop-${playerProps.length + 1}`,
      badge,
      label: c.label,
      player: c.player ?? "",
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      estimatedProbability: c.grade?.modelProb ?? null,
      ...pickSource(c),
      reason,
    });
    decisions.set(c.key, { section: "prop", badge, reason });
  }
}


/** The team a prop belongs to, taken only from the verified availability report. */
function propTeam(game: GameRow, player: string | undefined): string | null {
  const wanted = (player ?? "").trim().toLowerCase();
  if (!wanted) return null;
  for (const injury of game.injuries ?? []) {
    if ((injury.player ?? "").trim().toLowerCase() !== wanted) continue;
    if (injury.team === game.home_team) return game.home_team;
    if (injury.team === game.away_team) return game.away_team;
  }
  return null;
}

/**
 * Touchdown picks, in their own section: one Anytime TD and one First TD for
 * each team, taken only from verified posted scorer markets and ranked by the
 * simulated scoring runs. When the feed cannot prove which team a scorer plays
 * for, the pick is still posted from the real market and says so, rather than
 * guessing at a roster.
 */
/** First TD cards state only the simulated count — no price, edge or status read. */
export function firstTdReason(wins: number, runs: number): string {
  const pct = runs > 0 ? Math.round((wins / runs) * 1000) / 10 : 0;
  return `Scored the game's first touchdown in ${wins}/${runs} simulated games (${pct}%) — the most of any posted scorer on his team.`;
}

function fillTouchdownBets(
  game: GameRow,
  candidates: Candidate[],
  used: Set<string>,
  touchdownBets: PropBet[],
  decisions: DecisionMap,
): void {
  const pool = candidates.filter(
    (c) =>
      c.group === "prop" &&
      !used.has(c.key) &&
      (c.market === "player_anytime_td" || c.market === "player_1st_td") &&
      ["yes", "over"].includes(propDirection(c)) &&
      c.grade?.modelProb != null,
  );
  if (!pool.length) return;

  // First TD scorers are chosen purely by how often the player scored the
  // game's first touchdown in the 100 simulated games — price never selects.
  const firstTdCount = (c: Candidate) => c.simProb ?? -1;
  const ranked = [...pool]
    .filter((c) => c.market !== "player_1st_td" || c.simProb != null)
    .sort((a, b) =>
      a.market === "player_1st_td" && b.market === "player_1st_td"
        ? firstTdCount(b) - firstTdCount(a)
        : candidateRank(b) - candidateRank(a),
    );
  const takenPlayers = new Set<string>();

  const take = (c: Candidate, team: string | null) => {
    const first = c.market === "player_1st_td";
    const badge = propBadge(c);
    used.add(c.key);
    takenPlayers.add(`${c.player ?? ""}|${c.market}`);
    const reason = first
      ? firstTdReason(Math.round((c.simProb ?? 0) * 100), 100)
      : team
      ? `${team} touchdown pick: the strongest posted price for this scorer market under the simulated scoring runs.`
      : "The strongest posted price in this scorer market under the simulated scoring runs. The feed does not name this player's team, so no team is claimed.";
    touchdownBets.push({
      key: `td-${touchdownBets.length + 1}`,
      badge,
      label: c.label,
      player: c.player ?? "",
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      estimatedProbability: c.grade?.modelProb ?? null,
      touchdown: true,
      team,
      ...pickSource(c),
      reason,
    });
    decisions.set(c.key, { section: "prop", badge, reason });
  };

  for (const market of ["player_anytime_td", "player_1st_td"]) {
    for (const team of [game.home_team, game.away_team]) {
      const pick = ranked.find(
        (c) =>
          c.market === market &&
          !used.has(c.key) &&
          propTeam(game, c.player) === team &&
          !takenPlayers.has(`${c.player ?? ""}|${c.market}`),
      );
      if (pick) take(pick, team);
    }
    // Without a verified roster the feed cannot attribute every scorer, so the
    // section is completed from the same posted market with no team claimed.
    const perMarket = () => touchdownBets.filter((b) => b.market === PROP_MARKET_LABEL[market]).length;
    while (perMarket() < 2) {
      const pick = ranked.find(
        (c) =>
          c.market === market &&
          !used.has(c.key) &&
          !takenPlayers.has(`${c.player ?? ""}|${c.market}`),
      );
      if (!pick) break;
      take(pick, propTeam(game, pick.player));
    }
  }
}



/** How reliable a candidate's probability estimate is (0-1). */
function candidateRobustness(c: Candidate): number {
  if (!c.grade) return 0.5;
  return robustnessScore({
    grade: c.grade,
    group: c.group,
    probGain: c.alt ? c.alt.probGain : null,
    keysCrossed: c.alt ? c.alt.keysCrossed.length : 0,
  });
}

/**
 * Mild ranking preference for playable prices: a standard or lightly juiced
 * number is preferred over a heavily juiced one when the edges are close.
 */
function pricePreference(price: number): number {
  if (price <= -160) return 0.9;
  if (price <= -135) return 0.96;
  if (price >= 400) return 0.94;
  return 1;
}

/** Risk-adjusted ranking number: edge in uncertainty bands, discounted by robustness. */
function candidateRank(c: Candidate): number {
  if (!c.grade) return 0;
  const edge = c.grade.edge ?? 0;
  // A clean 2%+ edge is preferred over a sliver of an edge at the same risk.
  const edgePreference = edge >= TARGET_EDGE * 2 ? 1.15 : edge >= TARGET_EDGE ? 1.1 : edge >= MIN_EDGE ? 1 : 0.5;
  return riskAdjustedScore(c.grade, candidateRobustness(c)) * pricePreference(c.price) * edgePreference;
}

function leadCheck(c: Candidate): { ok: boolean; why: string } {
  if (!c.grade) return { ok: false, why: "no supportable probability estimate" };
  return canLeadBoard(c.grade, candidateRobustness(c));
}

/**
 * The sharpest posted alternate measured against one standard candidate, or
 * undefined when none of them beats that number on graded value. Used so the
 * alternate curve is searched by the formula itself, on both sides of a market,
 * rather than only when the handicap read happens to nominate one.
 */
/**
 * The most-protected posted alternate for a standard spread pick: same side,
 * more points, crosses a key number the simulated games confirm, priced from
 * -100 to -180 and still carrying a positive edge. Never moves away from the
 * key number. Returns the standard pick unchanged when no rung qualifies.
 */
export function preferKeyNumberSpread(c: Candidate, candidates: Candidate[]): Candidate {
  if (c.group !== "core" || c.market !== "spread" || c.point == null) return c;
  const standardPoint = c.point;
  const priceOk = (p: number) =>
    (p >= MIN_RECOMMENDED_PRICE && p <= -100) || (p >= 100 && p <= MAX_TOP_PRICE);
  const rungs = candidates
    .filter(
      (x) =>
        x.group === "alt" &&
        x.alt?.market === "spread" &&
        x.standardKey === c.key &&
        // Same team, always: an alternate never switches sides.
        x.selection === c.selection &&
        x.alt.side === c.selection &&
        x.alt.standardPoint === standardPoint &&
        x.point != null &&
        x.point > standardPoint &&
        Boolean(x.alt.keyGate?.ok) &&
        !altTooFar(x) &&
        priceOk(x.price) &&
        hasAnyPositiveEdge(x),
    )
    .sort((a, b) => (b.point ?? 0) - (a.point ?? 0) || b.price - a.price);
  // Standard sitting within a point of a real football scoring margin (3, 7,
  // 10, 14, 17 …): take the first posted rung that moves strictly past that
  // margin (e.g. +6.5 or +7 -> +7.5, -7.5 -> -6.5), even if the standard line
  // grades a higher edge on its own.
  const nearKeys = FOOTBALL_KEY_MARGINS.filter((k) => Math.abs(k - Math.abs(standardPoint)) <= 1);
  const passesNearKey = (point: number) => {
    const ts = -standardPoint;
    const ta = -point;
    return nearKeys.some((k) => [k, -k].some((m) => ta < m && m <= ts));
  };
  const nearRung = rungs
    .filter((x) => passesNearKey(x.point as number))
    .sort((a, b) => (a.point ?? 0) - (b.point ?? 0) || b.price - a.price)[0];
  return nearRung ?? rungs[0] ?? c;
}

/**
 * Final guard on any alternate spread headed for the Top 2: it must sit on the
 * same team as its own standard line and give more protection than it. A rung
 * that fails is replaced by that standard line — never by the other team.
 */
export function enforceAltSpreadSide(c: Candidate, byKey: Map<string, Candidate>): Candidate {
  if (c.group !== "alt" || c.market !== "alternate_spreads") return c;
  const standard = c.standardKey ? byKey.get(c.standardKey) : undefined;
  const ok =
    standard != null &&
    standard.market === "spread" &&
    standard.selection === c.selection &&
    c.alt?.side === c.selection &&
    c.point != null &&
    standard.point != null &&
    c.point > standard.point;
  if (ok) return c;
  console.warn("Lock Lab rejected an alternate spread that did not stay on its own side", c.label);
  // Fall back to the standard line of the alternate's OWN team, never the other team's.
  const own = [...byKey.values()].find(
    (x) => x.group === "core" && x.market === "spread" && x.selection === c.selection,
  );
  return own ?? c;
}

/** Plain reason for taking a key-number spread alternate over the standard line. */
function keySpreadReason(c: Candidate): string {
  const why = c.alt?.keyGate?.why;
  return `Lock Lab takes the extra protection at a negative price.${why ? ` ${why}` : ""}`;
}

function bestGradedAlternate(
  standard: Candidate,
  candidates: Candidate[],
  used: Set<string>,
): Candidate | undefined {
  return candidates
    .filter(
      (x) =>
        x.group === "alt" &&
        x.alt != null &&
        x.alt.worthIt &&
        x.standardKey === standard.key &&
        x.selection === standard.selection &&
        !used.has(x.key) &&
        eligibleForTop(x).ok &&
        beatsStandardEdge(x, standard),
    )
    .sort((a, b) => candidateRank(b) - candidateRank(a))[0];
}

/** One short sentence explaining why this alternate beats its standard line. */
function altPreferenceReason(c: Candidate): string {
  const keys = c.alt?.keysCrossed ?? [];
  const bought = (c.alt?.probGain ?? 0) > 0;
  const keyText = keys.length ? ` The move crosses ${keys.join(" and ")}.` : "";
  return bought
    ? `Lock Lab prefers this number: the extra points buy more winning chance than the extra juice costs.${keyText}`
    : `Lock Lab prefers this number: the price gain outweighs the protection given up.${keyText}`;
}


function pickSource(c: Candidate) {
  return {
    point: c.point,
    price: c.price,
    book: c.book,
    bookKey: c.bookKey,
    capturedAt: c.capturedAt,
    // Ties the published pick back to the graded selection so it can be
    // settled against the same 100 simulated games it was chosen from.
    candidateKey: c.key,
  };
}

/**
 * Settles every published pick against the 100 simulated games: game picks on
 * the simulated final scores and player props on the player stat
 * lines drawn inside those same games. A pick with no simulated settlement is
 * left untouched and falls back to the existing price-based settlement.
 */
/** The 100 stored simulated results for a candidate, or null when it cannot be settled. */
function candidateOutcomes(
  c: Candidate,
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
): boolean[] | null {
  const sideOf = (team: string): "home" | "away" | null =>
    team === game.home_team ? "home" : team === game.away_team ? "away" : null;
  if (c.group === "prop") {
    return players.outcomes({ market: c.market, player: c.player, selection: c.selection, point: c.point });
  }
  const market = c.market.toLowerCase();
  if (market.includes("spread")) {
    const side = sideOf(c.selection);
    return side && c.point != null ? projection.spreadOutcomes(side, c.point) : null;
  }
  if (market.includes("total") && !market.includes("team_total")) {
    const side = c.selection === "Over" || c.selection === "Under" ? c.selection : null;
    return side && c.point != null ? projection.totalOutcomes(side, c.point) : null;
  }
  if (market === "moneyline" || market === "h2h") {
    const side = sideOf(c.selection);
    return side ? projection.moneylineOutcomes(side) : null;
  }
  return null;
}

function impliedFromAmerican(price: number): number {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/** Simulated hit rate minus the price's implied probability — the exact edge published on the card. */
export function simulatedEdge(hits: number, runs: number, price: number): number {
  return hits / runs - impliedFromAmerican(price);
}

/** Profit per unit staked when the bet wins, from the exact American price. */
export function payoutMultiplier(price: number): number {
  return price > 0 ? price / 100 : 100 / Math.abs(price);
}

/**
 * Expected return per unit staked at the exact sportsbook price, using the
 * simulated hit rate: p * profit - (1 - p). This is the ranking metric, because
 * a percentage-point edge cannot compare a +160 underdog with a -110 favourite
 * — the same edge pays very differently at the two prices.
 */
export function expectedRoi(hits: number, runs: number, price: number): number {
  if (!runs) return 0;
  const p = hits / runs;
  return p * (payoutMultiplier(price) + 1) - 1;
}

function candidateSimEdge(
  c: Candidate,
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
): number | null {
  const o = candidateOutcomes(c, game, projection, players);
  if (!o || !o.length) return null;
  return simulatedEdge(o.filter(Boolean).length, o.length, c.price);
}

/**
 * An alternate is only posted when its own simulated value holds up: a
 * positive edge at its real price and — for non-spread alternates — at least
 * the edge of the standard line it replaces. Otherwise the standard line of
 * the same selection is posted instead. Extra points alone never qualify.
 */
export function requireSimulatedAltValue(
  c: Candidate,
  byKey: Map<string, Candidate>,
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
): Candidate {
  if (c.group !== "alt") return c;
  const standard = c.standardKey ? byKey.get(c.standardKey) : undefined;
  if (!standard || standard.selection !== c.selection) return c;
  const altEdge = candidateSimEdge(c, game, projection, players);
  if (altEdge == null) return standard;
  if (altEdge <= 0) return standard;
  if (c.market !== "alternate_spreads" && c.alt?.market !== "spread") {
    const stdEdge = candidateSimEdge(standard, game, projection, players);
    if (stdEdge != null && altEdge < stdEdge) return standard;
  }
  return c;
}

/**
 * Stable re-order by the same composite as selection: simulated hit rate
 * first, expected return at the posted price as support. Near-ties keep the
 * selection order (which already applied the sportsbook-side tiebreaker).
 */
export function orderTopBetsByValue<T extends { simHits?: number[] | null | undefined; simRuns?: number | null | undefined; odds?: string | null | undefined; key: string }>(
  bets: T[],
): (T & { rank: number })[] {
  const scoreOf = (b: T): number => {
    const price = b.odds ? Number(String(b.odds).replace("+", "")) : NaN;
    if (!b.simRuns || !Number.isFinite(price)) return -Infinity;
    const hits = b.simHits?.length ?? 0;
    return simulationStrength(expectedRoi(hits, b.simRuns, price), hits / b.simRuns, null);
  };
  return bets
    .map((b, i) => ({ b, i, s: scoreOf(b) }))
    .sort((x, y) => (Math.abs(y.s - x.s) < CLOSE_SCORE ? x.i - y.i : y.s - x.s))
    .map(({ b }, index) => ({ ...b, key: `top${index + 1}`, rank: index + 1 }) as T & { rank: number });
}

function attachSimulatedOutcomes(
  output: EngineOutput,
  candidates: Candidate[],
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
  odds: GameOdds | null = null,
  previousOdds: GameOdds | null = null,
): EngineOutput {
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  const settle = <T extends { candidateKey?: string | null }>(pick: T): T => {
    const c = pick.candidateKey ? byKey.get(pick.candidateKey) : undefined;
    const result = c ? candidateOutcomes(c, game, projection, players) : null;
    if (!result || !result.length) return pick;
    const hits: number[] = [];
    result.forEach((won, index) => {
      if (won) hits.push(index + 1);
    });
    return { ...pick, simRuns: result.length, simHits: hits };
  };

  const playerProps = output.playerProps.map(settle);
  const reserved = new Set(
    playerProps.map((p) => p.candidateKey).filter((k): k is string => Boolean(k)),
  );
  const topBets = simulationFirstTop2(output.topBets.map(settle), candidates, byKey, reserved, game, projection, players, odds, previousOdds);

  return {
    ...output,
    topBets: orderTopBetsByValue(topBets),
    playerProps,
    funBets: [],
  };
}

/**
 * Composite strength of a bet after the full simulation. How often the bet
 * wins in the 100 simulated games leads; expected return at the exact posted
 * price is a meaningful supporting factor (so a heavily juiced favourite does
 * not win on frequency alone), and model confidence (injuries, matchup) adds a
 * small nudge.
 */
export function simulationStrength(
  roi: number,
  hitRate: number,
  tier: string | null | undefined,
): number {
  const confidence = tier === "strong" ? 1 : tier === "playable" ? 0.5 : 0;
  return hitRate + 0.5 * Math.max(-0.3, Math.min(0.3, roi)) + 0.01 * confidence;
}

/** Two bets within this composite gap are "very close" in the simulation. */
const CLOSE_SCORE = 0.02;

const impliedOf = (price: number | null | undefined): number | null => {
  if (price == null || !Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
};
const clip1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Which outcome the sportsbook is positioned to prefer, read only from real
 * posted odds: the side carrying the heavier juice at the same number, and the
 * side whose number has worsened since the last snapshot, is where the money
 * is. The book benefits when the OTHER side wins. Returns -1..+1 (+ = this
 * side is the book-favourable outcome). Secondary signal / tiebreaker only.
 */
export function sportsbookSideSignal(
  c: Pick<Candidate, "key" | "standardKey" | "group">,
  odds: GameOdds | null | undefined,
  previous: GameOdds | null | undefined,
  publicBetting?: PublicBetting | null,
): number {
  const side = c.group === "alt" ? c.standardKey : c.key;
  const publicSignal = publicSideSignal(side, publicBetting);
  if (!odds) return publicSignal ?? 0;
  let juice = 0;
  let move = 0;
  const diff = (own: number | undefined, opp: number | undefined) => {
    const a = impliedOf(own);
    const b = impliedOf(opp);
    return a == null || b == null ? 0 : -clip1((a - b) / 0.05);
  };
  switch (side) {
    case "spread-home":
      juice = diff(odds.spread?.homePrice, odds.spread?.awayPrice);
      if (previous?.spread && odds.spread) move = clip1((odds.spread.home - previous.spread.home) / 1);
      break;
    case "spread-away":
      juice = diff(odds.spread?.awayPrice, odds.spread?.homePrice);
      if (previous?.spread && odds.spread) move = clip1((odds.spread.away - previous.spread.away) / 1);
      break;
    case "total-over":
      juice = diff(odds.total?.overPrice, odds.total?.underPrice);
      if (previous?.total && odds.total) move = clip1(-(odds.total.points - previous.total.points) / 1.5);
      break;
    case "total-under":
      juice = diff(odds.total?.underPrice, odds.total?.overPrice);
      if (previous?.total && odds.total) move = clip1((odds.total.points - previous.total.points) / 1.5);
      break;
    case "ml-home":
    case "ml-away": {
      const k = side === "ml-home" ? "home" : "away";
      const now = impliedOf(odds.moneyline?.[k]);
      const then = impliedOf(previous?.moneyline?.[k]);
      // Own implied chance rising = money on this side = book prefers the other.
      if (now != null && then != null) move = clip1(-(now - then) / 0.04);
      break;
    }
    default:
      return 0;
  }
  return 0.6 * juice + 0.4 * move;
}

/**
 * Simulation-first Top 2. Every eligible posted game bet (standard and
 * alternate, -180 to +199, key/side rules intact, not already used by props or
 * TD Scorers) is settled against the same simulated games and ranked by how
 * often it wins, supported by expected return at its exact price and model
 * confidence. The sportsbook-favourable side only breaks near-ties.
 */
function simulationFirstTop2(
  current: PickBet[],
  candidates: Candidate[],
  byKey: Map<string, Candidate>,
  reserved: Set<string>,
  game: GameRow,
  projection: GameProjection,
  players: PlayerProjection,
  odds: GameOdds | null = null,
  previousOdds: GameOdds | null = null,
): PickBet[] {
  type Scored = { c: Candidate; hits: number[]; runs: number; edge: number; roi: number; score: number };
  const scored: Scored[] = [];
  for (const raw of candidates) {
    if (raw.group === "prop" || reserved.has(raw.key)) continue;
    if (raw.price < MIN_RECOMMENDED_PRICE || isLongshotPrice(raw.price)) continue;
    if (failsKeyGate(raw) || altTooFar(raw)) continue;
    const c = raw.group === "alt"
      ? requireSimulatedAltValue(enforceAltSpreadSide(raw, byKey), byKey, game, projection, players)
      : raw;
    if (c !== raw) continue; // the standard line is scored on its own
    const outcomes = candidateOutcomes(c, game, projection, players);
    if (!outcomes || !outcomes.length) continue;
    const hits: number[] = [];
    outcomes.forEach((won, i) => won && hits.push(i + 1));
    const hitRate = hits.length / outcomes.length;
    const edge = simulatedEdge(hits.length, outcomes.length, c.price);
    const roi = expectedRoi(hits.length, outcomes.length, c.price);
    scored.push({
      c,
      hits,
      runs: outcomes.length,
      edge,
      roi,
      score: simulationStrength(roi, hitRate, c.grade?.tier),
    });
  }
  if (scored.length < 2 && current.length >= 2) return current;

  // Simulation frequency leads; price/EV and model confidence support it. Only
  // when two bets are genuinely close does the sportsbook-favourable signal
  // (juice shading + line movement) decide the order.
  scored.sort((a, b) => b.score - a.score);
  const signal = (s: Scored) => sportsbookSideSignal(s.c, odds, previousOdds);
  for (let pass = 0; pass < scored.length; pass += 1) {
    for (let i = 0; i + 1 < scored.length; i += 1) {
      const a = scored[i]!;
      const b = scored[i + 1]!;
      if (a.score - b.score < CLOSE_SCORE && signal(b) > signal(a) + 0.1) {
        scored[i] = b;
        scored[i + 1] = a;
      }
    }
  }
  const picked: Scored[] = [];
  const ideas = new Set<string>();
  // A plus-money alternate whose simulated edge is under 1% ("thin") is not
  // worth giving up the standard number: post the regular line of the same
  // selection instead (e.g. Over 41.5 -110 rather than Over 43.5 +109).
  const standardFor = (s: Scored): Scored => {
    if (s.c.group !== "alt" || s.c.price < 100 || s.edge >= 0.01 || !s.c.standardKey) return s;
    const std = byKey.get(s.c.standardKey);
    if (!std || std.selection !== s.c.selection || reserved.has(std.key)) return s;
    const found = scored.find((x) => x.c.key === std.key);
    if (found) return found;
    const outcomes = candidateOutcomes(std, game, projection, players);
    if (!outcomes || !outcomes.length) return s;
    const hits: number[] = [];
    outcomes.forEach((won, i) => won && hits.push(i + 1));
    const roi = expectedRoi(hits.length, outcomes.length, std.price);
    return {
      c: std,
      hits,
      runs: outcomes.length,
      edge: simulatedEdge(hits.length, outcomes.length, std.price),
      roi,
      score: simulationStrength(roi, hits.length / outcomes.length, std.grade?.tier),
    };
  };
  for (const raw of scored) {
    if (picked.length >= 2) break;
    const s = standardFor(raw);
    if (picked.some((p) => p.c.key === s.c.key)) continue;
    const idea = betIdeaKey(s.c);
    if (ideas.has(idea)) continue;
    ideas.add(idea);
    picked.push(s);
  }
  // Keep any existing bet the board had if the pool could not supply two.
  const out: PickBet[] = [];
  const existingByKey = new Map(current.map((b) => [b.candidateKey, b]));
  for (const s of picked) {
    const prior = existingByKey.get(s.c.key);
    if (prior) {
      out.push({ ...prior, simHits: s.hits, simRuns: s.runs });
      continue;
    }
    const standard = s.c.standardKey ? byKey.get(s.c.standardKey) : undefined;
    const comparison = s.c.alt ? (s.c.alt.market === "spread" ? keySpreadReason(s.c) : altPreferenceReason(s.c)) : null;
    out.push({
      key: `top${out.length + 1}`,
      rank: out.length + 1,
      badge: softBadge(s.c),
      label: s.c.label,
      market: s.c.marketLabel,
      selection: s.c.player ?? s.c.selection,
      line: s.c.line,
      odds: fmtOdds(s.c.price),
      ...pickSource(s.c),
      ...(standard
        ? {
            standardLabel: standard.label,
            standardPoint: standard.point,
            standardPrice: standard.price,
            standardBook: standard.book,
            standardCapturedAt: standard.capturedAt,
            standardComparison: comparison,
          }
        : {}),
      reason:
        comparison ??
        `Won ${s.hits.length} of ${s.runs} simulated games — among the two strongest bets by simulated frequency, supported by the price and matchup read.`,
      simHits: s.hits,
      simRuns: s.runs,
    } as PickBet);
  }
  for (const b of current) {
    if (out.length >= 2) break;
    if (!out.some((o) => o.candidateKey === b.candidateKey)) out.push(b);
  }
  return out;
}

const CORE_OPPOSITE: Record<string, string> = {
  "spread-home": "spread-away",
  "spread-away": "spread-home",
  "total-over": "total-under",
  "total-under": "total-over",
  "ml-home": "ml-away",
  "ml-away": "ml-home",
};

const near = (a: number | null, b: number | null) =>
  a != null && b != null && Math.abs(a - b) < 0.01;

/**
 * The genuinely opposing, separately priced selection for a candidate — the
 * only thing that can be graded as the flip side of a bad bet. Returns
 * undefined when the book posts no opposing price (common on anytime-TD
 * markets), in which case Lock Lab reports NO VALID BAD-BET FLIP rather than
 * inventing one.
 */
function findOpposite(c: Candidate, candidates: Candidate[], game: GameRow): Candidate | undefined {
  const coreKey = CORE_OPPOSITE[c.key];
  if (coreKey) return candidates.find((x) => x.key === coreKey);

  if (c.market === "alternate_spreads") {
    const otherTeam = c.selection === game.home_team ? game.away_team : game.home_team;
    return candidates.find(
      (x) => x.market === c.market && x.selection === otherTeam && near(x.point, -(c.point ?? 0)),
    );
  }

  const side = c.selection.toLowerCase();
  const flip =
    side === "over" ? "under" : side === "under" ? "over" : side === "yes" ? "no" : side === "no" ? "yes" : null;
  if (!flip) return undefined;

  return candidates.find(
    (x) =>
      x.key !== c.key &&
      x.market === c.market &&
      (x.player ?? null) === (c.player ?? null) &&
      x.selection.toLowerCase() === flip &&
      (c.point == null ? x.point == null : near(x.point, c.point)),
  );
}

// ---------------------------------------------------------------------------
// Handicap pass
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Lock Lab handicapper for NFL and college football.

Work the pillars in this exact order and weight them this way:

1. MARKET FIRST. The posted spread, total, moneyline and prop prices are your prior. Never fade the market without a specific, measurable reason (internal mispricing between spread and moneyline, key-number position, lopsided juice, a meaningful injury the number has not absorbed). Call out a line that looks inflated or unusually bad.

1b. READ WHY THE NUMBER IS WHERE IT IS. A line that looks too short for the favourite is information, not a gift. When the supplied form context shows the public read (last week's results) is several points more aggressive than the posted spread, the book is refusing to pay the public price — that is a bait number and the underdog side deserves the harder look. Two specific patterns:
 - KEY-NUMBER RESISTANCE: a favourite parked at -2.5, -6.5 or -9.5 instead of the other side of 3, 7 or 10 means the book will not sell the dog the key number. Treat that as the market protecting itself against the dog covering.
 - RECENCY BIAS: blowout winners are overpriced the following week and blowout losers are underpriced. Use the multi-week differential supplied, never a single result, and never write "they just beat X badly" as a reason for a pick.
 In both cases the signal is a reason to look, not a bet on its own. It must be confirmed by the trenches, QB, injury and game-script pillars before it can carry a green or yellow, and it must never override the probability-vs-price rules below.
2. QUARTERBACK. Quality, matchup, health, recent form, performance under pressure, mobility, expected environment. "Active" or "no injury designation" is NOT evidence a QB is healthy or that his team is a good bet, and must never be your stated reason.
3. TRENCHES — HIGHEST-WEIGHT ON-FIELD FACTOR. OL vs DL both ways: pass protection, pass rush, run blocking, run defence, pressure rate, sack rate, specific matchup advantages. Injuries to QBs and offensive linemen carry heavy weight.
4. SKILL PLAYERS. WR/TE/RB matchup edges, explosive-play ability, target and carry share, matchup vs the opposing secondary and front, availability and role.
5. DEFENCE. Overall quality, pass vs run defence, pressure and coverage, red-zone defence, turnover tendencies, matchup-specific strengths and weaknesses.
6. GAME SCRIPT. Most likely environment: pace, expected scoring, pass/run volume, who plays from ahead or behind. Use it to judge spread, total and props together.
7. INJURIES / AVAILABILITY. Only the supplied injury list is current data. Separate real contributors from irrelevant names. Never assert a player is active or inactive beyond what that list states, and never infer that a player is healthy because he is absent from the list. If availability matters to a pick and the data does not settle it, say plainly in the reason that the status is uncertain. Never invent a player, a role, a usage share or a projection: only players named on the candidate board or the injury list exist.

EVIDENCE WEIGHTS — weigh everything you have, in this priority:
- Highest: current price and market value, quarterback, OL vs DL trenches, major injuries and availability, matchup-specific offensive/defensive advantages.
- Medium: skill-player matchups, game script, pace, usage.
- Supporting: line movement, public betting information, narrative.

LINE MOVEMENT IS NOT A PREREQUISITE. It is a supporting signal only. When no previous snapshot exists there is simply no movement evidence, and that is NOT a reason to pass or to downgrade a bet. Never write "no movement evidence" as a reason. A bet earns green or yellow when the matchup edge is strong, the price is favourable, the trenches / QB / skill / defence / game-script read supports it and the posted number offers value — with or without movement data. Equally, you MUST still return an empty top list when the evidence genuinely does not establish an edge; a market that simply looks efficient is not an edge. Do not pass merely because the spread and moneyline agree or because the matchup is not overwhelming.

PROBABILITY VS PRICE — this decides the ranking:
- Every candidate carries its implied probability at the posted price, Lock Lab's estimated win probability, the resulting edge, the expected value per $1, its uncertainty band and a risk-adjusted score stated in bands of that uncertainty. Read those numbers before you rank anything.
- A bet is only good when the estimated win probability beats the implied probability by more than the noise in the estimate. A big payout is NEVER a reason. Never write that a larger payout compensates for a tougher cover — that reasoning is rejected in code.
- The uncertainty band already widens with price length, alternate distance and weak evidence. So a long price is not banned: it simply has a wider band to clear. Judge it on its risk-adjusted score, not on the fact that it is plus money.
- Rank the top two by risk-adjusted value (edge relative to uncertainty), never by EV alone and never by payout size. A candidate scoring above one full band outranks a higher-EV candidate scoring below one band.
- Raw EV never sets the order. Rank by risk-adjusted value: the edge in uncertainty bands, discounted by how reliable that estimate is. A prop, a long price, a one-sided market and especially an alternate that SELLS points (fewer points for a bigger payout, e.g. +7 down to +2.5) all estimate worse and are discounted accordingly. A +200-or-longer candidate must not be #1 when its edge only partly clears its band.
- When a top bet is an alternate on the same side as a standard line, state the comparison plainly: points surrendered or bought, what the price change is worth, and whether the trade is justified. Never take fewer points just because the payout is bigger.
- For each bet you put in the Top 2, set probabilityLean: how many percentage points your handicap read moves the true win chance away from the market's own vig-free number, from -6 to +6. Zero means the market has it right, and a bet with no lean has no edge. Only move it for a concrete, stated reason (trench mismatch, quarterback, injury, game script). Also set evidenceStrength from 0 to 1 for how solid that read is; thin or speculative reads must stay below 0.5. Never invent a lean to manufacture a bet.
- Positive EV alone is NOT green. YELLOW is a real rating, not a consolation: a genuine playable edge belongs in the Top 2 as YELLOW. Do not return an empty board just because nothing is strong enough for GREEN. Still return no bet when every candidate's edge sits inside the noise. Green needs a strong matchup case plus an edge clearing the full band. An interesting edge that only clears part of the band is yellow at best. Inside the noise, or negative expectation, is red or left off entirely.
- Use probability language in reasons ("priced below where this projects to cash", "the number is short of the estimate") but never print a percentage or a decimal.

ALTERNATE LINES — check these on every game:
- The standard spread and total are NOT the only options. Every alternate spread and alternate total posted by the book is on your board, already graded: each one states the cash-chance gained over the standard line, what the worse price costs in break-even terms, the net of the two, and any key number the move crosses.
- Walk the whole posted curve on the side you like (for example -4.5, -5.5, -6.5, -7.5, -8.5) and compare estimated probability against implied probability at each rung, not just the longest one. The standard line never wins automatically, and neither does the alternate.
- Ask explicitly: is the sharpest bet the standard line, or an alternate? Buying through a key number (3, 7, 10) is often worth real juice; buying points that cross nothing usually is not. Compare the two directly (for example +2.5 versus +3.5) and reach one of four conclusions: the alternate is sharper, the standard is better value, the other side is better, or pass.
- The board summary tells you whether alternate markets were supplied at all. If none were supplied, you may say so; if they were supplied, never claim alternates do not exist — say they were evaluated and, if you rejected them, that the extra juice outweighed the added protection.
- NEVER take an alternate just because it has more points. Take it only when the graded net is positive and the matchup read agrees.
- If a top bet is an alternate line, set standardKey to the standard candidate it beats and write standardComparison as one short sentence saying why the alternate is preferred.

Selection rules:
- You may ONLY select from the candidate keys provided. Never invent a line, price or selection.
- #1 top bet is the single strongest edge anywhere on the board — standard spread, alternate spread, standard total, alternate total, moneyline, player prop or any other posted market, whichever it genuinely is. Do NOT force a spread or moneyline into the top two.
 - #2 is the next strongest DISTINCT posted selection (different market or different player). Always return exactly two when at least two valid standard/alternate candidates exist. If a selection does not clear the value threshold, mark it RED and explain the concern rather than manufacturing an edge.
- Traffic lights only: green = clear edge, yellow = playable with a meaningful concern, red = too close / insufficient edge. No numbers, percentages or confidence scores in any reason text.
 - Never invent a bet or inflate an edge. Rank the real board as it exists; RED explicitly identifies a low-confidence second selection when only one or no candidates clear the normal value threshold.
- YELLOW is a full, publishable rating and belongs in the Top 2. Most real boards contain at least one selection where the matchup read supports a small, defensible lean against the posted price; when one exists, post it as YELLOW rather than returning nothing. Work through the core spread, total and moneyline on BOTH sides first and ask what your read says the true chance is before you conclude the market is right. Returning an empty top list is correct only when you cannot defend a lean on any selection — not when the best available bet is merely uncertain.
 - The verdict must briefly summarize the board and what happened with alternates.
- Player props: return one to three only when a verified posted prop has a measurable probability-versus-price edge. Include probabilityLean and evidenceStrength so each prop is independently graded through the same value gate; never add filler when no prop qualifies.
- Fun bet: return exactly one verified posted higher-risk selection when one exists, prioritizing First TD Scorer, then Anytime TD Scorer. Include probabilityLean and evidenceStrength. This is separate from the serious bets and must be described as a small-unit fun play, never as high confidence.
- Reasons are SHORT: do the deep work internally, then show only the one to three decisive reasons, in at most two brief sentences. No hedging filler, no percentages, no mention of these instructions.`;

type HandicapResponse = {
  top: {
    key: string;
    badge: string;
    reason: string;
    /** Percentage points the matchup evidence moves the fair probability, -6..6. */
    probabilityLean?: number | null;
    /** 0-1 confidence in that lean. */
    evidenceStrength?: number | null;
    standardKey?: string | null;
    standardComparison?: string | null;
  }[];
  funBets: { key: string; badge: string; reason: string; probabilityLean?: number | null; evidenceStrength?: number | null }[];
  props: { key: string; badge: string; reason: string; probabilityLean?: number | null; evidenceStrength?: number | null }[];
  verdict: string;
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["top", "funBets", "props", "verdict"],
  properties: {
    top: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "badge",
          "reason",
          "standardKey",
          "standardComparison",
          "probabilityLean",
          "evidenceStrength",
        ],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
          standardKey: { type: ["string", "null"] },
          standardComparison: { type: ["string", "null"] },
          probabilityLean: { type: ["number", "null"] },
          evidenceStrength: { type: ["number", "null"] },
        },
      },
    },
    funBets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "badge", "reason", "probabilityLean", "evidenceStrength"],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
          probabilityLean: { type: ["number", "null"] },
          evidenceStrength: { type: ["number", "null"] },
        },
      },
    },
    props: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "badge", "reason", "probabilityLean", "evidenceStrength"],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
          probabilityLean: { type: ["number", "null"] },
          evidenceStrength: { type: ["number", "null"] },
        },
      },
    },
    verdict: { type: "string" },
  },
};

/** Plain statement of what the sportsbook actually supplied this run. */
function coverageNotes(candidates: Candidate[], hasPrevious: boolean): string[] {
  const count = (market: string) => candidates.filter((c) => c.market === market).length;
  const altSpreads = count("alternate_spreads");
  const altTotals = count("alternate_totals");
  const teamTotals = count("team_totals");
  const props = candidates.filter((c) => c.group === "prop").length;
  const notes: string[] = [];
  notes.push(
    altSpreads
      ? `Alternate spreads supplied and graded: ${altSpreads} posted prices. Evaluate them against the standard spread.`
      : "No alternate spread market was supplied by the sportsbook for this game.",
  );
  notes.push(
    altTotals
      ? `Alternate totals supplied and graded: ${altTotals} posted prices. Evaluate them against the standard total.`
      : "No alternate total market was supplied by the sportsbook for this game.",
  );
  if (teamTotals) notes.push(`Team totals supplied: ${teamTotals} posted prices.`);
  notes.push(
    props
      ? `Player props supplied and verified for this exact game: ${props} posted selections.`
      : "No verified player prop market was supplied for this game.",
  );
  notes.push(
    hasPrevious
      ? "A previous odds snapshot exists, so line movement above is real evidence."
      : "No previous odds snapshot exists, so there is no line-movement data. This is NOT a reason to pass or to downgrade any bet — judge on price, matchup and the pillars.",
  );
  return notes;
}

async function runHandicapPass(
  game: GameRow,
  candidates: Candidate[],
  marketNotes: string[],
  coverage: string[],
): Promise<HandicapResponse | null> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return null;

  const board = candidates.map((c) => ({
    key: c.key,
    group: c.group,
    market: c.marketLabel,
    selection: c.label,
    price: c.price,
    ...(c.point != null ? { line: c.point } : {}),
    ...(c.player ? { player: c.player } : {}),
    note: c.note,
  }));

  const prompt = [
    `Matchup: ${game.away_team} at ${game.home_team} (${game.sport}).`,
    `Kickoff: ${game.commence_time}.`,
    `Odds snapshot captured: ${game.odds.capturedAt ?? game.odds_updated_at ?? "unknown"} at ${game.odds.bookmaker ?? "unknown book"}.`,
    "",
    "MARKET COVERAGE SUPPLIED BY THE SPORTSBOOK THIS RUN:",
    ...coverage.map((n) => `- ${n}`),
    "",
    "MARKET READ (vig removed, computed from the exact posted snapshot):",
    ...marketNotes.map((n) => `- ${n}`),
    "",
    game.injuries?.length
      ? `CURRENT INJURY REPORT (the only availability data you have):\n${JSON.stringify(game.injuries)}`
      : "CURRENT INJURY REPORT: none supplied. Do not assert anything about availability.",
    "",
    "CANDIDATE BOARD — you may only reference these keys:",
    JSON.stringify(board),
  ].join("\n");

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "openai/gpt-6-astra",
        instructions: SYSTEM_PROMPT,
        input: prompt,
        stream: true,
        reasoning: { effort: "medium", summary: "auto" },
        store: false,
        text: {
          format: { type: "json_schema", name: "lock_lab_board", strict: true, schema: RESPONSE_SCHEMA },
        },
      }),
    });

    if (!res.ok || !res.body) {
      console.error("Lock Lab handicap pass failed", res.status, await res.text());
      return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload) as {
            type?: string;
            delta?: string;
            response?: { output_text?: string };
          };
          if (event.type === "response.output_text.delta" && event.delta) text += event.delta;
          if (event.type === "response.completed" && event.response?.output_text) {
            text = event.response.output_text;
          }
        } catch {
          // keep-alive / partial frame
        }
      }
    }

    if (!text.trim()) return null;
    return JSON.parse(text) as HandicapResponse;
  } catch (error) {
    console.error("Lock Lab handicap pass error", error);
    return null;
  }
}

function asBadge(value: string | undefined): Badge {
  return BADGES.includes(value as Badge) ? (value as Badge) : "red";
}

/** Reasoning that ranks a bet by payout rather than probability is rejected. */
const PAYOUT_CLICHE =
  /(larger|bigger|longer|plus[- ]money|extra)\s+(payout|price|return|money)|payout\s+(compensates|makes up|justifies|outweighs)|worth the risk for the (payout|price)|pays (enough|more) to/i;

function clean(text: string | undefined, fallback: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return fallback;
  // Strip any numeric confidence the model tries to smuggle in.
  if (PAYOUT_CLICHE.test(trimmed)) return fallback;
  const stripped = trimmed
    .replace(/\b\d{1,3}(\.\d+)?\s?%/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!stripped) return fallback;
  // Displayed reasons stay short: the deep reasoning is internal, the user
  // sees only the decisive points — at most two sentences.
  const sentences = stripped.match(/[^.!?]+[.!?]*/g) ?? [stripped];
  return sentences.slice(0, 2).join("").trim() || fallback;
}

/**
 * Deterministic fallback when the handicap pass is unavailable: Lock Lab does
 * not guess. It reports the market read and passes on the board.
 */
function passingBoard(
  candidates: Candidate[],
  verdict: string,
  game?: GameRow,
  extra: ExtraOffers = { alternates: [], props: [] },
): EngineOutput {
  return {
    topBets: [],
    funBets: [],
    playerProps: [],
    notes: {
      propsAvailable: extra.props.length > 0,
      altMarketsAvailable: extra.alternates.length > 0,
      verdict,
    },
    candidateAudit: game
      ? buildCandidateAudit(game, candidates, extra, new Map())
      : {
          generatedAt: new Date().toISOString(),
          gameId: null,
          providerGameId: null,
          snapshotBook: null,
          snapshotCapturedAt: null,
          altMarketsSupplied: 0,
          propMarketsSupplied: 0,
          standardMarketsEvaluated: 0,
          alternateMarketsReceived: 0,
          alternateMarketsEvaluated: 0,
          alternateBooks: [],
          ladder: [],
          bestCandidate: null,
          strongestAlternate: null,
          strongestAlternateOutcome: "ALTERNATE LINES UNAVAILABLE — cannot line-shop this game.",
          standardVsAlternateEdge: null,
          entries: [],
          strongestRejected: null,
        },

  };
}

function auditEntry(
  c: Candidate,
  decision: CandidateAuditEntry["decision"],
  section: CandidateAuditEntry["section"],
  reason: string,
): CandidateAuditEntry {
  const g = c.grade;
  return {
    key: c.key,
    label: c.label,
    market: c.marketLabel,
    group: c.group,
    kind: c.group === "prop" ? "prop" : c.group === "alt" ? "alternate" : "standard",
    book: c.book,
    line: c.line,
    price: c.price,
    estimatedProb: g?.modelProb ?? null,
    impliedProb: g?.impliedProb ?? impliedProbability(c.price),
    edge: g?.edge ?? null,
    ev: g?.ev ?? null,
    uncertainty: g?.uncertainty ?? 0,
    requiredEdge: g?.requiredEdge ?? 0,
    tier: g?.tier ?? "insufficient",
    valueScore: g?.valueScore ?? null,
    decision,
    section,
    reason,
    standardLine: c.alt ? String(c.alt.standardPoint) : null,
    standardPrice: c.alt ? c.alt.standardPrice : null,
    alternateConsidered: Boolean(c.alt),
    alternateBetterThanStandard: c.alt ? c.alt.worthIt : null,
  };
}

/**
 * Records what the engine actually considered on this board and why each
 * candidate survived or was rejected. Internal calibration data only: every
 * number here is the same one the selection logic used, nothing is re-derived
 * or rounded up for presentation.
 */
function buildCandidateAudit(
  game: GameRow,
  candidates: Candidate[],
  extra: ExtraOffers,
  decisions: Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>,
): CandidateAudit {
  const entries: CandidateAuditEntry[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const decided = decisions.get(c.key);
    if (!decided) continue;
    seen.add(c.key);
    entries.push(auditEntry(c, decided.badge, decided.section, decided.reason));
  }

  // Everything else that was on the board, strongest measured edge first, so a
  // systematically undervalued selection shows up at the top of the trail.
  const rest = candidates
    .filter((c) => !seen.has(c.key))
    .slice()
    .sort((a, b) => (b.grade?.edge ?? -Infinity) - (a.grade?.edge ?? -Infinity));

  for (const c of rest) {
    if (entries.length >= 40) break;
    const gate = eligibleForTop(c);
    const reason = !gate.ok
      ? gate.why
      : c.grade?.modelProb == null
        ? "No supportable probability estimate for this selection."
        : c.grade.qualifies
          ? "Cleared the value gate but the handicap read did not rank it in the top two."
          : `${c.grade.note}`;
    entries.push(auditEntry(c, "pass", null, reason));
  }

  const strongestRejected =
    entries
      .filter((e) => e.section == null && e.edge != null)
      .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity))[0] ?? null;

  // Ladder coverage: how much of the alternate market was actually measured,
  // and what happened to the single best rung on it.
  const altCandidates = candidates.filter((c) => c.group === "alt" && c.alt != null);
  const bestAlt = altCandidates
    .slice()
    .sort((a, b) => candidateRank(b) - candidateRank(a))[0];
  const bestAltEntry = bestAlt ? (entries.find((e) => e.key === bestAlt.key) ?? null) : null;
  const strongestAlternateOutcome = !extra.alternates.length
    ? "ALTERNATE LINES UNAVAILABLE — cannot line-shop this game."
    : !bestAlt
      ? "Alternate prices were received but none could be graded against a standard line."
      : bestAltEntry && bestAltEntry.section != null
        ? `Selected (${bestAltEntry.section}): ${bestAltEntry.reason}`
        : `Rejected: ${
            !bestAlt.alt?.worthIt
              ? "the extra juice outweighs the protection it buys against the standard line. "
              : ""
          }${eligibleForTop(bestAlt).ok ? leadCheck(bestAlt).why || "not the sharpest risk-adjusted bet on the board." : eligibleForTop(bestAlt).why}`;
  // How much better (or worse) the best rung grades than the standard line it is
  // measured against, in uncertainty-band terms.
  const bestAltStandard = bestAlt?.standardKey
    ? candidates.find((c) => c.key === bestAlt.standardKey)
    : undefined;
  const standardVsAlternateEdge =
    bestAlt && bestAltStandard ? candidateRank(bestAlt) - candidateRank(bestAltStandard) : null;

  const bestCandidate =
    entries
      .slice()
      .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity))[0] ?? null;
  const alternateBooks = Array.from(
    new Set(altCandidates.map((c) => c.book).filter((b): b is string => Boolean(b))),
  );
  const ladder = altCandidates.map((c) => ({
    market: c.market,
    side: c.selection,
    line: c.point != null ? String(c.point) : null,
    price: c.price,
    book: c.book ?? (game.odds.bookmaker ?? "unknown"),
  }));

  return {
    generatedAt: new Date().toISOString(),
    gameId: game.id ?? null,
    providerGameId: game.provider_game_id ?? null,
    alternateBooks,
    ladder,
    bestCandidate,
    snapshotBook: game.odds.bookmaker ?? null,
    snapshotCapturedAt: game.odds.capturedAt ?? game.odds_updated_at ?? null,
    altMarketsSupplied: extra.alternates.length,
    propMarketsSupplied: extra.props.length,
    standardMarketsEvaluated: candidates.filter((c) => c.group === "core").length,
    alternateMarketsReceived: extra.alternates.length,
    alternateMarketsEvaluated: altCandidates.length,
    strongestAlternate: bestAltEntry,
    strongestAlternateOutcome,
    standardVsAlternateEdge,

    entries,
    strongestRejected,
  };
}

export async function runLockLabFormula(
  game: GameRow,
  odds: GameOdds,
  extra: ExtraOffers = { alternates: [], props: [] },
  previousOdds?: GameOdds | null,
): Promise<EngineOutput> {
  // FAIR LINE FIRST. The baseline model and its 100 simulated games are built
  // before a single sportsbook price is shopped, so no alternate can ever set
  // the projection it is then judged against.
  const fair = await buildFairModel(game, odds);
  const projection = simulateGame(game, fair);

  // Player stat lines are drawn inside those same 100 simulated games, so a
  // prop's probability is a count of simulated games, not a coin flip.
  const players = simulatePlayers(game, projection, extra.props);
  const candidates = buildCandidates(game, odds, extra, projection, players);
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  if (!candidates.length) {
    return passingBoard([], "Live odds unavailable for this game — there is no board to analyse.");
  }

  const market = readMarket(odds, game.sport, { home: game.home_team, away: game.away_team }, previousOdds);
  const altNotes = summariseAltValue(
    candidates.map((c) => c.alt).filter((a): a is AltEvaluation => Boolean(a)),
  );
  // Market-context reads are commentary only: they never touch the fair line.
  const context = await readMarketContext(game, market.marketMargin);
  const handicap = await runHandicapPass(
    game,
    candidates,
    [
      "LOCK LAB FAIR LINE (built before any line shopping — this is the model, everything below is reference):",
      ...projection.notes,
      ...players.notes,
      "",
      "MARKET READ (reference only):",
      ...market.notes,
      "",
      "MARKET CONTEXT — SECONDARY SIGNALS ONLY. These may never move the fair line above:",
      ...context.notes,
      "",
      ...altNotes,
    ],
    coverageNotes(candidates, Boolean(previousOdds)),
  );

  if (!handicap) {
    // Game picks come from the game markets only. Player props are selected
    // from their own separate pool and never occupy a Top 2 slot. Every posted
    // market inside the price cap is rankable; a fully eligible bet leads when
    // one exists, but the second slot only needs the strongest remaining
    // distinct market — a smaller edge is shown honestly by its light.
    const priced = candidates
      .filter(
        (c) =>
          c.group !== "prop" &&
          c.price >= MIN_RECOMMENDED_PRICE &&
          !isLongshotPrice(c.price) &&
          c.grade?.modelProb != null &&
          !altTooFar(c) &&
          !failsKeyGate(c),
      )
      .sort((a, b) => candidateRank(b) - candidateRank(a));
    const seenIdeas = new Set<string>();
    const distinct = priced.filter((c) => {
      const idea = betIdeaKey(c);
      if (seenIdeas.has(idea)) return false;
      seenIdeas.add(idea);
      return true;
    });
    const leadIndex = distinct.findIndex((c) => eligibleForTop(c).ok);
    const ranked = (
      leadIndex > 0
        ? [distinct[leadIndex]!, ...distinct.filter((_, i) => i !== leadIndex)]
        : distinct
    ).map((c, index) => {
      if (index >= 2) return c;
      const picked = requireSimulatedAltValue(
        enforceAltSpreadSide(preferKeyNumberSpread(c, candidates), byKey),
        byKey,
        game,
        projection,
        players,
      );
      // A plus-money alternate with only a thin edge is not worth giving up the
      // standard number: post the standard line instead (e.g. Over 41.5 -110
      // rather than Over 43.5 +109 flagged "too close").
      if (picked.alt && picked.price >= 100 && !eligibleForTop(picked).ok && picked.standardKey) {
        const standard = byKey.get(picked.standardKey);
        if (standard && standard.grade?.modelProb != null) return standard;
      }
      return picked;
    });
    const topBets = ranked.slice(0, 2).map((c, index): PickBet => {
      const standard = c.standardKey ? byKey.get(c.standardKey) : undefined;
      const eligible = eligibleForTop(c).ok;
      return {
        key: `top${index + 1}`,
        rank: index + 1,
        badge: eligible ? (c.grade?.tier === "strong" ? "green" : "yellow") : softBadge(c),
        label: c.label,
        market: c.marketLabel,
        selection: c.player ?? c.selection,
        line: c.line,
        odds: fmtOdds(c.price),
        ...pickSource(c),
        ...(standard
          ? {
              standardLabel: standard.label,
              standardPoint: standard.point,
              standardPrice: standard.price,
              standardBook: standard.book,
              standardCapturedAt: standard.capturedAt,
              standardComparison: c.alt?.market === "spread" ? keySpreadReason(c) : altPreferenceReason(c),
            }
          : {}),
        reason: eligible
          ? c.alt
            ? c.alt.market === "spread" ? keySpreadReason(c) : altPreferenceReason(c)
            : "The posted price carries a measurable edge under the existing market grade."
          : "This is the next-best posted option, but its estimated edge remains inside the model's uncertainty band.",
      };
    });
    const decisions = new Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>();
    const usedFallback = new Set<string>();
    topBets.forEach((bet, index) => {
      const c = ranked[index];
      if (c) {
        usedFallback.add(c.key);
        decisions.set(c.key, { section: "top", badge: bet.badge, reason: bet.reason });
      }
    });
    const fallbackProps: PropBet[] = [];
    const fallbackTd: PropBet[] = [];
    fillTouchdownBets(game, candidates, usedFallback, fallbackTd, decisions);
    fillPlayerProps(candidates, usedFallback, fallbackProps, decisions, 4);
    return attachSimulatedOutcomes(
      {
        topBets,
        funBets: [],
        playerProps: [...fallbackProps, ...fallbackTd],
        notes: {
          propsAvailable: extra.props.length > 0,
          altMarketsAvailable: extra.alternates.length > 0,
          verdict: null,
        },
        candidateAudit: buildCandidateAudit(game, candidates, extra, decisions),
      },
      candidates,
      game,
      projection,
      players,
      odds,
      previousOdds ?? null,
    );
  }

  const used = new Set<string>();

  const decisions = new Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>();
  const topBets: PickBet[] = [];
  const rejected: string[] = [];
  const shortlist: { c: Candidate; entry: (typeof handicap.top)[number] }[] = [];
  for (const entry of handicap.top ?? []) {
    const c = byKey.get(entry.key);
    if (!c || used.has(c.key)) continue;
    // Separate pools: a player prop never fills a game-pick slot.
    if (c.group === "prop") continue;
    // The market's own vig-free number is the starting point; the handicap read
    // may move it within a bounded range, for a stated reason, before the value
    // gate runs. Without a lean a bet simply matches the market and has no edge.
    applySideLean(c, candidates, entry.probabilityLean, entry.evidenceStrength);
    // Price must be beaten by the estimated win probability. A pick that only
    // looks good because it pays more is dropped here, never published.
    const eligible = eligibleForTop(c);
    if (!eligible.ok) {
      rejected.push(eligible.why);
      decisions.set(c.key, {
        section: null,
        badge: "red",
        reason: `Selected by the handicap read but blocked by the value gate. ${eligible.why}`,
      });
      continue;
    }
    // A second pick in the same market/player as the first is not distinct.
    if (shortlist.some((s) => betIdeaKey(s.c) === betIdeaKey(c))) {
      continue;
    }
    used.add(c.key);
    shortlist.push({ c, entry });
  }

  // Alternate-line sweep. A line-shopping step of the formula, not a display
  // extra: every posted rung of every ladder, both sides, has already been graded
  // against its own standard line. The sharpest of them always enters the ranking
  // pool — even when the standard line on that side is not recommended, and even
  // when the handicap read already filled the top slots, so a better number can
  // outrank a weaker standard pick. It must still beat its standard line on
  // graded value and clear the same uncertainty gates; nothing is added for
  // having more points or a bigger payout.
  const sweptAlternates: Candidate[] = candidates
    .filter((c) => c.group === "alt" && c.alt != null && c.alt.worthIt && !used.has(c.key))
    .filter((c) => eligibleForTop(c).ok)
    .filter((c) => beatsStandardEdge(c, c.standardKey ? byKey.get(c.standardKey) : undefined))
    .sort((a, b) => candidateRank(b) - candidateRank(a));
  for (const c of sweptAlternates.slice(0, 2)) {
    if (shortlist.some((s) => betIdeaKey(s.c) === betIdeaKey(c) && candidateRank(s.c) >= candidateRank(c))) {
      continue;
    }
    const reason = altPreferenceReason(c);
    used.add(c.key);
    shortlist.push({
      c,
      entry: {
        key: c.key,
        badge: c.grade?.tier === "strong" ? "green" : "yellow",
        reason,
        standardKey: c.standardKey ?? null,
        standardComparison: reason,
      },
    });
  }

  // Side first, then line. Once a selection has an underlying case, shop its own
  // posted ladder: if a rung on that same side carries better risk-adjusted value
  // than the number the read named, take that rung instead. The side does not
  // change here, only the number, and the swap happens solely on graded value —
  // never on the biggest number, the cheapest price or the standard tag.
  for (let i = 0; i < shortlist.length; i += 1) {
    const s = shortlist[i]!;
    if (s.c.group !== "core") continue;
    const better = bestGradedAlternate(s.c, candidates, used);
    if (!better || candidateRank(better) <= candidateRank(s.c)) continue;
    const reason = altPreferenceReason(better);
    used.add(better.key);
    decisions.set(s.c.key, {
      section: null,
      badge: "red",
      reason: `Passed over in favour of the sharper number on the same side: ${better.label}.`,
    });
    shortlist[i] = {
      c: better,
      entry: {
        key: better.key,
        badge: better.grade?.tier === "strong" ? "green" : "yellow",
        reason: s.entry.reason || reason,
        standardKey: better.standardKey ?? null,
        standardComparison: reason,
      },
    };
  }


  // Rank by risk-adjusted value: edge measured in uncertainty bands, discounted
  // by how reliable the estimate behind it is. Raw EV never sets the order.
  shortlist.sort((a, b) => candidateRank(b.c) - candidateRank(a.c));

  // One selection, one bet: when a standard line and a rung of its own ladder
  // both survive, only the sharper of the two is posted.
  const seenSelection = new Set<string>();
  for (let i = 0; i < shortlist.length; i += 1) {
    const id = betIdeaKey(shortlist[i]!.c);
    if (seenSelection.has(id)) {
      shortlist.splice(i, 1);
      i -= 1;
      continue;
    }
    seenSelection.add(id);
  }


  // #1 has to be able to carry the board. A partial-band edge at a long price
  // steps aside for a steadier bet, and leads only when nothing steadier exists
  // and it is still clearly the strongest risk-adjusted opportunity.
  if (shortlist.length) {
    const leadIndex = shortlist.findIndex((s) => leadCheck(s.c).ok);
    if (leadIndex > 0) {
      const [lead] = shortlist.splice(leadIndex, 1);
      shortlist.unshift(lead!);
    } else if (leadIndex === -1) {
      const head = shortlist[0]!;
      const check = leadCheck(head.c);
      // Only step a weak leader aside when a positive-edge replacement exists;
      // a legitimate lone pick is never dropped into an empty board.
      if (candidateRank(head.c) < 0.6 && shortlist.length > 1) {
        rejected.push(`${head.c.label}: ${check.why}.`);
        decisions.set(head.c.key, {
          section: null,
          badge: "red",
          reason: `Not posted as the top bet: ${check.why}.`,
        });
        shortlist.shift();
      }
    }
  }

  // Up to two real posted bets. Slots are filled from the strongest remaining
  // standard/alternate candidates, but only ones whose estimate still beats the
  // posted price: a negative-edge selection is left off entirely.
  const selectedIds = new Set(shortlist.map(({ c }) => c.key));
  const selectedIdeas = new Set(shortlist.map(({ c }) => betIdeaKey(c)));
  const remaining = candidates
    .filter(
      (c) =>
        c.group !== "prop" &&
        // Never fill a slot with a price we would not recommend.
        c.price >= MIN_RECOMMENDED_PRICE &&
        !isLongshotPrice(c.price) &&
        // Pick #2 only needs a measurable positive edge; its light shows the size.
        !failsKeyGate(c) &&
        hasAnyPositiveEdge(c) &&
        !selectedIds.has(c.key) &&
        !selectedIdeas.has(betIdeaKey(c)),
    )
    .sort((a, b) => candidateRank(b) - candidateRank(a))
    .filter((c) => {
      const idea = betIdeaKey(c);
      if (selectedIdeas.has(idea)) return false;
      selectedIdeas.add(idea);
      return true;
    });
  for (const c of remaining) {
    if (shortlist.length >= 2) break;
    shortlist.push({
      c,
      entry: {
        key: c.key,
        // A smaller edge than pick #1 is still a legitimate pick; the light
        // reflects the size of that edge rather than blanket-failing it.
        badge: softBadge(c),
        reason: "A distinct posted market whose simulated win rate still beats the price implied by the odds.",
        standardKey: c.standardKey ?? null,
        standardComparison: c.alt ? altPreferenceReason(c) : null,
      },
    });
    selectedIdeas.add(betIdeaKey(c));
  }

  // Last resort: when the board has two legitimate posted markets but the
  // value gates left a slot open, the strongest remaining distinct market
  // still posts — its light says exactly how thin the edge is rather than
  // the board showing NO BET with real prices available.
  // Last resort: Lock Lab always posts two Top Bets. When the gated pools run
  // dry, the next-best posted standard market fills the slot with its real,
  // unaltered edge (the light and write-up then show how thin it is).
  for (const strict of [true, false]) {
    if (shortlist.length >= 2) break;
    const pool = candidates
      .filter(
        (c) =>
          c.group !== "prop" &&
          c.price >= MIN_RECOMMENDED_PRICE &&
          !isLongshotPrice(c.price) &&
          !selectedIds.has(c.key) &&
          !selectedIdeas.has(betIdeaKey(c)) &&
          (strict
            ? c.grade?.modelProb != null && !altTooFar(c) && !failsKeyGate(c)
            : c.group === "core"),
      )
      .sort((a, b) => candidateRank(b) - candidateRank(a));
    for (const c of pool) {
      if (shortlist.length >= 2) break;
      shortlist.push({
        c,
        entry: {
          key: c.key,
          badge: softBadge(c),
          reason:
            "The strongest remaining posted market on this board; the light reflects how thin the modelled edge is.",
          standardKey: c.standardKey ?? null,
          standardComparison: c.alt ? altPreferenceReason(c) : null,
        },
      });
      selectedIds.add(c.key);
      selectedIdeas.add(betIdeaKey(c));
    }
  }
  if (shortlist.length < 2) {
    for (const c of candidates
      .filter(
        (c) =>
          c.group !== "prop" &&
          c.price >= MIN_RECOMMENDED_PRICE &&
          !isLongshotPrice(c.price) &&
          c.grade?.modelProb != null &&
          !altTooFar(c) &&
          !failsKeyGate(c) &&
          !selectedIds.has(c.key) &&
          !selectedIdeas.has(betIdeaKey(c)),
      )
      .sort((a, b) => candidateRank(b) - candidateRank(a))) {
      if (shortlist.length >= 2) break;
      shortlist.push({
        c,
        entry: {
          key: c.key,
          badge: softBadge(c),
          reason:
            "The strongest remaining posted market on this board; the light reflects how thin the modelled edge is.",
          standardKey: c.standardKey ?? null,
          standardComparison: c.alt ? altPreferenceReason(c) : null,
        },
      });
      selectedIds.add(c.key);
      selectedIdeas.add(betIdeaKey(c));
    }
  }

  // A standard spread pick always takes the most-protected key-number
  // alternate on the same side when one is posted at -100 to -180.
  for (let i = 0; i < Math.min(2, shortlist.length); i += 1) {
    const s = shortlist[i]!;
    const alt = preferKeyNumberSpread(s.c, candidates);
    if (alt === s.c) continue;
    used.add(alt.key);
    decisions.set(s.c.key, {
      section: null,
      badge: "red",
      reason: `Passed over for more protection across the key number: ${alt.label}.`,
    });
    const reason = keySpreadReason(alt);
    shortlist[i] = {
      c: alt,
      entry: { ...s.entry, key: alt.key, standardKey: alt.standardKey ?? null, standardComparison: reason },
    };
  }

  for (const { c: picked, entry: pickedEntry } of shortlist.slice(0, 2)) {
    let entry = pickedEntry;
    const c = requireSimulatedAltValue(enforceAltSpreadSide(picked, byKey), byKey, game, projection, players);
    if (c !== picked && c.group === "core") {
      entry = { ...entry, reason: "", standardKey: null, standardComparison: null };
    }
    // An alternate line always shows the standard number it beat, quoted from
    // the same snapshot, so the standard-vs-alternate decision is visible.
    const standard = c.standardKey ? byKey.get(c.standardKey) : undefined;
    const standardFields = standard
      ? {
          standardLabel: standard.label,
          standardPoint: standard.point,
          standardPrice: standard.price,
          standardBook: standard.book,
          standardCapturedAt: standard.capturedAt,
          standardComparison: clean(
            entry.standardComparison ?? undefined,
            c.alt?.worthIt
              ? "Lock Lab prefers the alternate: the extra points buy more winning chance than the extra juice costs."
              : "Lock Lab is taking this number over the standard line on the matchup read.",
          ),
        }
      : {};
    const badge = eligibleForTop(c).ok ? capBadge(c, asBadge(entry.badge)) : softBadge(c);
    topBets.push({
      key: `top${topBets.length + 1}`,
      rank: topBets.length + 1,
      badge,
      label: c.label,
      market: c.marketLabel,
      selection: c.player ?? c.selection,
      line: c.line,
      odds: fmtOdds(c.price),
      ...pickSource(c),
      ...standardFields,
      reason: clean(
        entry.reason,
        c.grade?.modelProb != null && c.grade.edge != null && c.grade.edge > 0
          ? "Lock Lab's win estimate for this selection sits above what the posted price implies, and the matchup read supports it."
          : "Priced below where this matchup projects.",
      ),
    });
    decisions.set(c.key, {
      section: "top",
      badge,
      reason: clean(entry.reason, "Selected as a top bet."),
    });
  }

  const playerProps: PropBet[] = [];
  // The handicap read's props are not inserted directly: their lean is applied
  // and their reasoning kept, then every prop (read-nominated or not) goes
  // through the same edge-first selector with the 1.5% diversity window.
  const propReasons = new Map<string, string>();
  for (const entry of handicap.props ?? []) {
    const c = byKey.get(entry.key);
    if (!c || c.group !== "prop" || used.has(c.key)) continue;
    applyLean(c, entry.probabilityLean, entry.evidenceStrength);
    propReasons.set(c.key, clean(entry.reason, "Usage and matchup back this number."));
  }

  // Sections are topped up from the ranked live board so a normal game shows
  // standard props plus the dedicated TD scorer section. Only real posted
  // prices are ever used.
  const touchdownBets: PropBet[] = [];
  // One Anytime TD and one First TD per team, in their own section, before the
  // standard props are filled so the two pools never take the same price.
  fillTouchdownBets(game, candidates, used, touchdownBets, decisions);
  fillPlayerProps(candidates, used, playerProps, decisions, 4, propReasons);


  const verdict = topBets.length === 2
    ? null
    : rejected.length
      ? `The live board did not contain two distinct price records. ${rejected[0]}`
      : clean(handicap.verdict, "The live board did not contain two distinct price records.");

  return attachSimulatedOutcomes(
    {
      topBets,
      funBets: [],
      playerProps: [...playerProps, ...touchdownBets],
      notes: {
        propsAvailable: extra.props.length > 0,
        altMarketsAvailable: extra.alternates.length > 0,
        verdict,
      },
      candidateAudit: buildCandidateAudit(game, candidates, extra, decisions),
    },
    candidates,
    game,
    projection,
    players,
    odds,
    previousOdds ?? null,
  );
}

export type StoredAnalysis = Pick<
  AnalysisRow,
  "top_bets" | "fun_bets" | "player_props" | "odds_snapshot"
>;
