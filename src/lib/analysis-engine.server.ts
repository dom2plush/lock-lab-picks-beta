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
  FunBet,
  GameOdds,
  GameRow,
  MarketOffer,
  PickBet,
  PropBet,
} from "./lock-lab-types";
import type { AltEvaluation, ValueGrade } from "./market-math.server";
import {
  createAltEvaluator,
  devig,
  gradeValue,
  robustnessScore,
  riskAdjustedScore,
  canLeadBoard,
  impliedProbability,
  readMarket,
  summariseAltValue,
} from "./market-math.server";

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
  player_rush_yds: "Rushing yards",
  player_reception_yds: "Receiving yards",
  player_receptions: "Receptions",
  player_1st_td: "First TD scorer",
  player_anytime_td: "Anytime TD",
};

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
  funBets: FunBet[];
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

function buildCandidates(
  game: GameRow,
  odds: GameOdds,
  extra: ExtraOffers,
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
    .map((offer) => ({ offer, evaluation: evaluator.evaluateOffer(offer) }));

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
    const count = perLadder.get(ladder) ?? 0;
    if (count >= 24) return;
    perLadder.set(ladder, count + 1);


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
  // Touchdown-scorer markets are read first so the per-game prop budget can
  // never cut them off before the fun bet gets a look at them.
  const propOffers = [...extra.props].sort(
    (a, b) => propMarketPriority(a.market) - propMarketPriority(b.market),
  );
  propOffers.forEach((offer, index) => {
    const side = offer.selection.toLowerCase();
    if (!["over", "under", "yes", "no"].includes(side)) return;
    if (!offer.player) return;
    const id = `${offer.market}:${offer.player}:${side}`;
    if (seen.has(id) || propCount >= 90) return;
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

  gradeBoard(out, game);
  return out;
}

/**
 * Connects every candidate's price to a probability estimate.
 *
 * Core two-way markets are estimated from the vig-free market read; alternates
 * from the modelled curve at that exact number (key-number mass included); props
 * from the posted two-way price when the book prices both sides. Nothing is
 * invented: a selection with no supportable estimate is graded as unrankable and
 * can never be a top bet on payout alone.
 */
function gradeBoard(candidates: Candidate[], game: GameRow) {
  const pairFair = (a: number, b: number) => devig(a, b);

  for (const c of candidates) {
    let modelProb: number | null = null;
    let distance = 0;
    let evidence = 0.4;

    if (c.group === "core") {
      const opposite = candidates.find((x) => x.key === CORE_OPPOSITE[c.key]);
      modelProb = opposite ? pairFair(c.price, opposite.price).a : impliedProbability(c.price);
      // A two-sided posted market is the most reliable evidence on the board.
      evidence = opposite ? 0.65 : 0.35;
    } else if (c.alt) {
      modelProb = c.alt.winProb;
      distance = Math.abs(c.alt.point - c.alt.standardPoint);
      evidence = Math.max(0.15, 0.45 + (c.alt.worthIt ? 0.2 : -0.1) - 0.03 * distance);
    } else if (c.group === "prop") {
      const opposite = findOpposite(c, candidates, game);
      modelProb = opposite ? pairFair(c.price, opposite.price).a : null;
      evidence = opposite ? 0.5 : 0.25;
    }

    c.grade = gradeValue({ modelProb, price: c.price, group: c.group, distance, evidenceStrength: evidence });
    c.note = `${c.note} ${c.grade.note}`;
  }
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

  if (g.modelProb == null) {
    return { ok: false, why: `${c.label}: no supported probability estimate to justify this price.` };
  }

  if (g.ev != null && g.ev <= 0) {
    return { ok: false, why: `${c.label}: negative expected value once the estimated win chance is priced in.` };
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
  if (!g) return "red";
  if (g.tier === "strong") return "green";
  if (g.edge != null && g.edge >= 0.005) return "yellow";
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
 * Props are not held to the Top 2 edge threshold. Their light reflects how
 * likely the model thinks the prop hits: green for a confident read, yellow for
 * a live one, red only when the model genuinely expects it to miss.
 */
function propBadge(c: Candidate): Badge {
  const g = c.grade;
  if (!g || g.modelProb == null) return "red";
  if (g.tier === "strong" || g.modelProb >= 0.6) return "green";
  return g.modelProb >= 0.45 ? "yellow" : "red";
}

/**
 * The fun bet is an explicit long shot, so its light reads as a fun play rather
 * than a confidence claim: yellow whenever the price is real and the model gives
 * it a live chance, green only for an unusually strong one.
 */
function funBadge(c: Candidate): Badge {
  const g = c.grade;
  if (!g || g.modelProb == null) return "red";
  if (g.modelProb >= 0.5) return "green";
  return g.modelProb >= 0.1 ? "yellow" : "red";
}

function propMarketPriority(market: string): number {
  return market === "player_1st_td" ? 0 : market === "player_anytime_td" ? 1 : 2;
}

type DecisionMap = Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>;

/**
 * Tops the prop section up to the requested minimum from real posted prices the
 * board actually ranks. Nothing is invented: when the sportsbook supplied no
 * further verified prop, the section simply stays short.
 */
function fillPlayerProps(
  candidates: Candidate[],
  used: Set<string>,
  playerProps: PropBet[],
  decisions: DecisionMap,
  minimum = 2,
): void {
  const pool = candidates
    .filter((c) => c.group === "prop" && !used.has(c.key))
    // Touchdown markets are held back for the fun bet where possible.
    .sort(
      (a, b) =>
        (propMarketPriority(a.market) === 2 ? 0 : 1) - (propMarketPriority(b.market) === 2 ? 0 : 1) ||
        candidateRank(b) - candidateRank(a),
    );
  for (const c of pool) {
    if (playerProps.length >= minimum) break;
    if (playerProps.some((p) => p.player === (c.player ?? "") && p.market === c.marketLabel)) continue;
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
      reason: "The strongest remaining posted prop on this board under the model's usage and matchup read.",
    });
    decisions.set(c.key, { section: "prop", badge, reason: "Player prop from the ranked board." });
  }
}

/** Exactly one higher-variance scoring play, First TD first, then Anytime TD. */
function fillFunBet(
  candidates: Candidate[],
  used: Set<string>,
  funBets: FunBet[],
  decisions: DecisionMap,
): void {
  if (funBets.length) return;
  const pool = candidates
    .filter((c) => c.group === "prop" && !used.has(c.key))
    .sort(
      (a, b) =>
        propMarketPriority(a.market) - propMarketPriority(b.market) ||
        candidateRank(b) - candidateRank(a),
    );
  const c = pool[0];
  if (!c) return;
  const badge = funBadge(c);
  used.add(c.key);
  funBets.push({
    key: "fun-1",
    badge,
    label: c.label,
    market: c.marketLabel,
    odds: fmtOdds(c.price),
    estimatedProbability: c.grade?.modelProb ?? null,
    ...pickSource(c),
    reason:
      "A posted scoring price the board likes as a swing play. For fun only — keep it to smaller units.",
  });
  decisions.set(c.key, { section: "fun", badge, reason: "Fun bet from the ranked board." });
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

/** Risk-adjusted ranking number: edge in uncertainty bands, discounted by robustness. */
function candidateRank(c: Candidate): number {
  if (!c.grade) return 0;
  return riskAdjustedScore(c.grade, candidateRobustness(c));
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
        !used.has(x.key) &&
        eligibleForTop(x).ok,
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
  };
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
  const candidates = buildCandidates(game, odds, extra);
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  if (!candidates.length) {
    return passingBoard([], "Live odds unavailable for this game — there is no board to analyse.");
  }

  const market = readMarket(odds, game.sport, { home: game.home_team, away: game.away_team }, previousOdds);
  const altNotes = summariseAltValue(
    candidates.map((c) => c.alt).filter((a): a is AltEvaluation => Boolean(a)),
  );
  const handicap = await runHandicapPass(
    game,
    candidates,
    [...market.notes, ...altNotes],
    coverageNotes(candidates, Boolean(previousOdds)),
  );

  if (!handicap) {
    const measurable = candidates
      .filter((c) => eligibleForTop(c).ok)
      .sort((a, b) => candidateRank(b) - candidateRank(a));
    const seenIdeas = new Set<string>();
    const distinct = measurable.filter((c) => {
      const idea = betIdeaKey(c);
      if (seenIdeas.has(idea)) return false;
      seenIdeas.add(idea);
      return true;
    });
    const included = new Set(distinct.map((c) => c.key));
    const ranked = [
      ...distinct,
      ...candidates
        .filter((c) => c.group !== "prop" && !included.has(c.key))
        .sort((a, b) => candidateRank(b) - candidateRank(a))
        .filter((c) => {
          const idea = betIdeaKey(c);
          if (seenIdeas.has(idea)) return false;
          seenIdeas.add(idea);
          return true;
        }),
    ];
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
              standardComparison: altPreferenceReason(c),
            }
          : {}),
        reason: eligible
          ? c.alt
            ? altPreferenceReason(c)
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
    const fallbackFun: FunBet[] = [];
    fillPlayerProps(candidates, usedFallback, fallbackProps, decisions);
    fillFunBet(candidates, usedFallback, fallbackFun, decisions);
    return {
      topBets,
      funBets: fallbackFun,
      playerProps: fallbackProps,
      notes: {
        propsAvailable: extra.props.length > 0,
        altMarketsAvailable: extra.alternates.length > 0,
        verdict: null,
      },
      candidateAudit: buildCandidateAudit(game, candidates, extra, decisions),
    };
  }

  const used = new Set<string>();

  const decisions = new Map<string, { section: CandidateAuditEntry["section"]; badge: Badge; reason: string }>();
  const topBets: PickBet[] = [];
  const rejected: string[] = [];
  const shortlist: { c: Candidate; entry: (typeof handicap.top)[number] }[] = [];
  for (const entry of handicap.top ?? []) {
    const c = byKey.get(entry.key);
    if (!c || used.has(c.key)) continue;
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
      if (candidateRank(head.c) < 0.6) {
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

  // The result contract is exactly two real posted bets. If fewer than two
  // selections clear the value gate, fill from the strongest remaining
  // standard/alternate candidates and mark them RED. This ranks the live board
  // without inventing an edge, line, price, book or timestamp.
  const selectedIds = new Set(shortlist.map(({ c }) => c.key));
  const selectedIdeas = new Set(shortlist.map(({ c }) => betIdeaKey(c)));
  const remaining = candidates
    .filter((c) => c.group !== "prop" && !selectedIds.has(c.key) && !selectedIdeas.has(betIdeaKey(c)))
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
        badge: "red",
        reason: "This is the next-best posted option, but its estimated edge remains inside the model's uncertainty band.",
        standardKey: c.standardKey ?? null,
        standardComparison: c.alt ? altPreferenceReason(c) : null,
      },
    });
    selectedIdeas.add(betIdeaKey(c));
  }

  for (const { c, entry } of shortlist.slice(0, 2)) {
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

  const funBets: FunBet[] = [];
  const funEntries = [...(handicap.funBets ?? [])].sort((a, b) => {
    const marketA = byKey.get(a.key)?.market ?? "";
    const marketB = byKey.get(b.key)?.market ?? "";
    const priority = (marketName: string) => marketName === "player_1st_td" ? 0 : marketName === "player_anytime_td" ? 1 : 2;
    return priority(marketA) - priority(marketB);
  });
  for (const entry of funEntries) {
    const c = byKey.get(entry.key);
    if (!c || used.has(c.key) || c.group !== "prop") continue;
    applyLean(c, entry.probabilityLean, entry.evidenceStrength);
    used.add(c.key);
    funBets.push({
      key: `fun-${funBets.length + 1}`,
      badge: asBadge(entry.badge),
      label: c.label,
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      estimatedProbability: c.grade?.modelProb ?? null,
      ...pickSource(c),
      reason: `${clean(entry.reason, "A posted scoring price with a real matchup reason behind it.")} For fun only — keep it to smaller units.`,
    });
    decisions.set(c.key, {
      section: "fun",
      badge: asBadge(entry.badge),
      reason: clean(entry.reason, "Fun bet."),
    });
    break;
  }

  const playerProps: PropBet[] = [];
  for (const entry of handicap.props ?? []) {
    const c = byKey.get(entry.key);
    if (!c || c.group !== "prop" || used.has(c.key)) continue;
    applyLean(c, entry.probabilityLean, entry.evidenceStrength);
    if (!eligibleForTop(c).ok) continue;
    used.add(c.key);
    playerProps.push({
      key: `prop-${playerProps.length + 1}`,
      badge: asBadge(entry.badge),
      label: c.label,
      player: c.player ?? "",
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      estimatedProbability: c.grade?.modelProb ?? null,
      ...pickSource(c),
      reason: clean(entry.reason, "Usage and matchup back this number."),
    });
    decisions.set(c.key, {
      section: "prop",
      badge: asBadge(entry.badge),
      reason: clean(entry.reason, "Player prop."),
    });
    if (playerProps.length === 3) break;
  }

  // Sections are topped up from the ranked live board so a normal game shows
  // two props and one fun bet. Only real posted prices are ever used.
  fillPlayerProps(candidates, used, playerProps, decisions);
  fillFunBet(candidates, used, funBets, decisions);


  const verdict = topBets.length === 2
    ? null
    : rejected.length
      ? `The live board did not contain two distinct price records. ${rejected[0]}`
      : clean(handicap.verdict, "The live board did not contain two distinct price records.");

  return {
    topBets,
    funBets,
    playerProps,
    notes: {
      propsAvailable: extra.props.length > 0,
      altMarketsAvailable: extra.alternates.length > 0,
      verdict,
    },
    candidateAudit: buildCandidateAudit(game, candidates, extra, decisions),
  };
}

export type StoredAnalysis = Pick<
  AnalysisRow,
  "top_bets" | "fun_bets" | "player_props" | "odds_snapshot"
>;
