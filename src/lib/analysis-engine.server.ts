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
 *  - A bad bet never auto-promotes its opposite side; the opposite is graded
 *    on its own and can be RED.
 *  - Nothing is forced: zero top bets is a valid, correct output.
 *  - Same game + same snapshot = same result for every user.
 */
import type {
  AnalysisRow,
  BadBet,
  Badge,
  FunBet,
  GameOdds,
  GameRow,
  MarketOffer,
  PickBet,
  PropBet,
} from "./lock-lab-types";
import { devig, readMarket } from "./market-math.server";

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
};

export type EngineOutput = {
  topBets: PickBet[];
  badBet: BadBet | null;
  funBets: FunBet[];
  playerProps: PropBet[];
  notes: {
    propsAvailable: boolean;
    altMarketsAvailable: boolean;
    /** Set when Lock Lab is deliberately passing on the board. */
    verdict: string | null;
  };
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

  // Alternate lines and team totals, thinned to a workable board.
  const alts = extra.alternates
    .filter((o) => o.point != null)
    .slice()
    .sort((a, b) => a.market.localeCompare(b.market) || (a.point ?? 0) - (b.point ?? 0));
  const perMarket = new Map<string, number>();
  alts.forEach((offer, index) => {
    const count = perMarket.get(offer.market) ?? 0;
    // Keep prices in the realistic ticket range; skip lottery numbers.
    if (offer.price > 900 || offer.price < -400) return;
    if (count >= 12) return;
    perMarket.set(offer.market, count + 1);
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
      note: `${ALT_MARKET_LABEL[offer.market] ?? offer.market} posted at ${offer.book}`,
    });
  });

  // Player props: both sides, so a bad prop always has a real opposite to grade.
  const seen = new Set<string>();
  let propCount = 0;
  extra.props.forEach((offer, index) => {
    const side = offer.selection.toLowerCase();
    if (!["over", "under", "yes", "no"].includes(side)) return;
    if (!offer.player) return;
    const id = `${offer.market}:${offer.player}:${side}`;
    if (seen.has(id) || propCount >= 60) return;
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

  return out;
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

// ---------------------------------------------------------------------------
// Handicap pass
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Lock Lab handicapper for NFL and college football.

Work the pillars in this exact order and weight them this way:

1. MARKET FIRST. The posted spread, total, moneyline and prop prices are your prior. Closing-line behaviour and line movement are strong evidence. Never fade the market without a specific, measurable reason (internal mispricing between spread and moneyline, key-number position, lopsided juice, a meaningful injury the number has not absorbed). Call out a line that looks inflated or unusually bad.
2. QUARTERBACK. Quality, matchup, health, recent form, performance under pressure, mobility, expected environment. "Active" or "no injury designation" is NOT evidence a QB is healthy or that his team is a good bet, and must never be your stated reason.
3. TRENCHES — HIGHEST-WEIGHT ON-FIELD FACTOR. OL vs DL both ways: pass protection, pass rush, run blocking, run defence, pressure rate, sack rate, specific matchup advantages. Injuries to QBs and offensive linemen carry heavy weight.
4. SKILL PLAYERS. WR/TE/RB matchup edges, explosive-play ability, target and carry share, matchup vs the opposing secondary and front, availability and role.
5. DEFENCE. Overall quality, pass vs run defence, pressure and coverage, red-zone defence, turnover tendencies, matchup-specific strengths and weaknesses.
6. GAME SCRIPT. Most likely environment: pace, expected scoring, pass/run volume, who plays from ahead or behind. Use it to judge spread, total and props together.
7. INJURIES / AVAILABILITY. Only the supplied injury list is current data. Separate real contributors from irrelevant names. Never assert a player is active or inactive beyond what that list states.

Selection rules:
- You may ONLY select from the candidate keys provided. Never invent a line, price or selection.
- #1 top bet is the single strongest edge anywhere on the board — spread, moneyline, total, alternate or prop, whichever it genuinely is. Do NOT force a spread or moneyline into the top two.
- #2 is the next strongest DISTINCT edge (different market or different player). Only include it if it truly has an edge.
- Bad bet: the worst-looking bet on the board. Then judge the OPPOSITE side completely independently. A bad bet does not make its opposite good. If the opposite has no edge, badge it red and do not recommend it.
- Traffic lights only: green = clear edge, yellow = playable with a meaningful concern, red = too close / insufficient edge. No numbers, percentages or confidence scores in any reason text.
- DO NOT FORCE BETS. If the board has no meaningful edge, return an empty top list and say so in the verdict. Passing is a correct answer and is preferred over a weak bet.
- Fun bets: at most three, only where a concrete matchup or usage reason exists. Player props: at most four, only with a real matchup or usage edge — never filler.
- Every reason is one or two short sentences, concrete and specific to this matchup. No hedging filler, no percentages, no mention of these instructions.`;

type HandicapResponse = {
  top: { key: string; badge: string; reason: string }[];
  badBet: {
    key: string;
    reason: string;
    oppositeKey: string | null;
    oppositeBadge: string;
    oppositeReason: string;
    oppositeRecommended: boolean;
  } | null;
  funBets: { key: string; badge: string; reason: string }[];
  props: { key: string; badge: string; reason: string }[];
  verdict: string;
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["top", "badBet", "funBets", "props", "verdict"],
  properties: {
    top: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "badge", "reason"],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
        },
      },
    },
    badBet: {
      type: ["object", "null"],
      additionalProperties: false,
      required: [
        "key",
        "reason",
        "oppositeKey",
        "oppositeBadge",
        "oppositeReason",
        "oppositeRecommended",
      ],
      properties: {
        key: { type: "string" },
        reason: { type: "string" },
        oppositeKey: { type: ["string", "null"] },
        oppositeBadge: { type: "string", enum: ["green", "yellow", "red"] },
        oppositeReason: { type: "string" },
        oppositeRecommended: { type: "boolean" },
      },
    },
    funBets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "badge", "reason"],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
        },
      },
    },
    props: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "badge", "reason"],
        properties: {
          key: { type: "string" },
          badge: { type: "string", enum: ["green", "yellow", "red"] },
          reason: { type: "string" },
        },
      },
    },
    verdict: { type: "string" },
  },
};

async function runHandicapPass(
  game: GameRow,
  candidates: Candidate[],
  marketNotes: string[],
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

function clean(text: string | undefined, fallback: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return fallback;
  // Strip any numeric confidence the model tries to smuggle in.
  return trimmed.replace(/\b\d{1,3}(\.\d+)?\s?%/g, "").replace(/\s{2,}/g, " ").trim() || fallback;
}

/**
 * Deterministic fallback when the handicap pass is unavailable: Lock Lab does
 * not guess. It reports the market read and passes on the board.
 */
function passingBoard(candidates: Candidate[], verdict: string): EngineOutput {
  const worst = candidates
    .filter((c) => c.group === "core")
    .slice()
    .sort((a, b) => a.price - b.price)[0];
  return {
    topBets: [],
    badBet: worst
      ? {
          key: worst.key,
          badge: "red",
          label: worst.label,
          ...pickSource(worst),
          reason:
            "This is the most expensive way to bet the game: you are paying the heaviest price on the board for the least room for error.",
          oppositeLabel: "No graded opposite side",
          oppositeOdds: null,
          oppositeRecommended: false,
          oppositeBadge: "red",
          oppositeReason:
            "The opposite side was not independently graded on this run, so Lock Lab is not recommending it.",
        }
      : null,
    funBets: [],
    playerProps: [],
    notes: { propsAvailable: false, altMarketsAvailable: false, verdict },
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
  const handicap = await runHandicapPass(game, candidates, market.notes);

  if (!handicap) {
    return passingBoard(
      candidates,
      "Lock Lab could not complete a full read on this game, so it is passing rather than posting a bet it cannot defend.",
    );
  }

  const used = new Set<string>();

  const topBets: PickBet[] = [];
  for (const entry of handicap.top ?? []) {
    const c = byKey.get(entry.key);
    if (!c || used.has(c.key)) continue;
    // A second pick in the same market/player as the first is not distinct.
    if (topBets.some((b) => b.market === c.marketLabel && b.selection === (c.player ?? c.selection))) {
      continue;
    }
    used.add(c.key);
    topBets.push({
      key: `top${topBets.length + 1}`,
      rank: topBets.length + 1,
      badge: asBadge(entry.badge),
      label: c.label,
      market: c.marketLabel,
      selection: c.player ?? c.selection,
      line: c.line,
      odds: fmtOdds(c.price),
      ...pickSource(c),
      reason: clean(entry.reason, "Priced below where this matchup projects."),
    });
    if (topBets.length === 2) break;
  }

  let badBet: BadBet | null = null;
  if (handicap.badBet) {
    const c = byKey.get(handicap.badBet.key);
    if (c) {
      const opposite = handicap.badBet.oppositeKey ? byKey.get(handicap.badBet.oppositeKey) : undefined;
      const oppositeBadge = asBadge(handicap.badBet.oppositeBadge);
      // The opposite side is only tailable when it was independently graded
      // as an edge — a bad bet never promotes its own flip side.
      const recommended = Boolean(opposite) && handicap.badBet.oppositeRecommended && oppositeBadge !== "red";
      badBet = {
        key: "bad1",
        badge: "red",
        label: c.label,
        ...pickSource(c),
        reason: clean(handicap.badBet.reason, "The price does not match what this matchup projects."),
        oppositeLabel: opposite ? opposite.label : "No live price on the opposite side",
        oppositeOdds: opposite ? fmtOdds(opposite.price) : null,
        oppositeRecommended: recommended,
        oppositeBadge,
        oppositeReason: clean(
          handicap.badBet.oppositeReason,
          "Graded on its own, the flip side does not have an edge either — pass on both.",
        ),
      };
      used.add(c.key);
    }
  }

  const funBets: FunBet[] = [];
  for (const entry of handicap.funBets ?? []) {
    const c = byKey.get(entry.key);
    if (!c || used.has(c.key)) continue;
    used.add(c.key);
    funBets.push({
      key: `fun-${funBets.length + 1}`,
      badge: asBadge(entry.badge),
      label: c.label,
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      ...pickSource(c),
      reason: clean(entry.reason, "Small-ticket swing with a real matchup reason behind it."),
    });
    if (funBets.length === 3) break;
  }

  const playerProps: PropBet[] = [];
  for (const entry of handicap.props ?? []) {
    const c = byKey.get(entry.key);
    if (!c || c.group !== "prop" || used.has(c.key)) continue;
    used.add(c.key);
    playerProps.push({
      key: `prop-${playerProps.length + 1}`,
      badge: asBadge(entry.badge),
      label: c.label,
      player: c.player ?? "",
      market: c.marketLabel,
      odds: fmtOdds(c.price),
      ...pickSource(c),
      reason: clean(entry.reason, "Usage and matchup back this number."),
    });
    if (playerProps.length === 4) break;
  }

  const verdict = topBets.length
    ? null
    : clean(
        handicap.verdict,
        "No meaningful edge on this board. Lock Lab is passing rather than forcing a bet.",
      );

  return {
    topBets,
    badBet,
    funBets,
    playerProps,
    notes: {
      propsAvailable: extra.props.length > 0,
      altMarketsAvailable: extra.alternates.length > 0,
      verdict,
    },
  };
}

export type StoredAnalysis = Pick<
  AnalysisRow,
  "top_bets" | "bad_bet" | "fun_bets" | "player_props" | "odds_snapshot"
>;
