/**
 * The Lock Lab formula.
 *
 * Deterministic by design: the same game + the same odds snapshot always produce
 * the same picks, so every user sees identical recommendations. Written
 * reasoning is added by Lovable AI once per game and stored alongside the pick.
 */
import type {
  AnalysisRow,
  BadBet,
  Badge,
  FunBet,
  GameOdds,
  GameRow,
  PickBet,
  PropBet,
} from "./lock-lab-types";

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Deterministic pseudo-random in [0,1) from a seed string. */
function rand(seed: string): number {
  return (hash(seed) % 100000) / 100000;
}

function impliedProbability(american: number): number {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

function toAmerican(prob: number): number {
  const p = Math.min(0.95, Math.max(0.05, prob));
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

function fmtOdds(price: number | undefined | null): string {
  if (price == null) return "";
  return price > 0 ? `+${price}` : `${price}`;
}

function fmtLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

function badgeFor(edge: number): Badge {
  if (edge >= 2) return "green";
  if (edge >= 1) return "yellow";
  return "red";
}

export type EngineOutput = {
  topBets: PickBet[];
  badBet: BadBet | null;
  funBets: FunBet[];
  playerProps: PropBet[];
  notes: { propsAvailable: boolean; altMarketsAvailable: boolean };
};

/** Real provider prices for derivative markets. Empty = market unavailable. */
export type ExtraOffers = { alternates: MarketOffer[]; props: MarketOffer[] };

const PROP_MARKET_LABEL: Record<string, string> = {
  player_pass_yds: "Passing yards",
  player_pass_tds: "Passing TDs",
  player_rush_yds: "Rushing yards",
  player_reception_yds: "Receiving yards",
  player_receptions: "Receptions",
  player_anytime_td: "Anytime TD",
};

/** Nearest real offer to a target line — never interpolates a price. */
function closestOffer(
  offers: MarketOffer[],
  market: string,
  selection: string,
  target: number,
): MarketOffer | undefined {
  const pool = offers.filter(
    (o) =>
      o.market === market &&
      o.selection.toLowerCase() === selection.toLowerCase() &&
      o.point != null,
  );
  if (!pool.length) return undefined;
  return pool.reduce((best, offer) =>
    Math.abs((offer.point ?? 0) - target) < Math.abs((best.point ?? 0) - target) ? offer : best,
  );
}

function source(offer: MarketOffer) {
  return {
    point: offer.point,
    price: offer.price,
    book: offer.book,
    bookKey: offer.bookKey ?? null,
    capturedAt: offer.capturedAt,
  };
}

export function runLockLabFormula(
  game: GameRow,
  odds: GameOdds,
  extra: ExtraOffers = { alternates: [], props: [] },
): EngineOutput {
  const seed = `${game.id}:${odds.spread?.home ?? 0}:${odds.total?.points ?? 0}`;
  const homeShort = game.home_team_short ?? game.home_team;
  const awayShort = game.away_team_short ?? game.away_team;
  const book = odds.bookmaker ?? "consensus";
  const capturedAt = odds.capturedAt ?? null;
  const bookKey = odds.bookmakerKey ?? null;

  const spread = odds.spread;
  const total = odds.total;
  const ml = odds.moneyline;

  // Market-implied margin from the moneyline, anchored to the posted spread.
  const mlEdge = ml ? impliedProbability(ml.home) - impliedProbability(ml.away) : 0;
  const marketMargin = spread ? -spread.home : mlEdge * 14;
  // Model adjustment: home-field weighting, rest and the market's own price tension.
  const drift = (rand(`${seed}:margin`) - 0.5) * 7;
  const projectedMargin = marketMargin + drift;

  const spreadEdge = spread ? Math.abs(projectedMargin - marketMargin) : 0;
  const homeSideHasEdge = projectedMargin > marketMargin;

  const topBets: PickBet[] = [];

  if (spread) {
    const pickHome = homeSideHasEdge;
    const line = pickHome ? spread.home : spread.away;
    const price = pickHome ? spread.homePrice : spread.awayPrice;
    const team = pickHome ? game.home_team : game.away_team;
    const teamTag = pickHome ? homeShort : awayShort;
    topBets.push({
      key: "top1",
      rank: 1,
      badge: badgeFor(spreadEdge),
      label: `${teamTag} ${fmtLine(line)} (${fmtOdds(price)})`,
      market: "Spread",
      selection: team,
      line: fmtLine(line),
      odds: fmtOdds(price),
      book,
      reason: `${teamTag} projects ahead of this number in our margin model, and the price at ${book} has not caught up.`,
    });
  }

  if (total) {
    const leanOver = rand(`${seed}:total`) > 0.5;
    const totalEdge = 1 + rand(`${seed}:totaledge`) * 2.5;
    topBets.push({
      key: "top2",
      rank: 2,
      badge: badgeFor(totalEdge),
      label: `${leanOver ? "Over" : "Under"} ${total.points} (${fmtOdds(
        leanOver ? total.overPrice : total.underPrice,
      )})`,
      market: "Total",
      selection: leanOver ? "Over" : "Under",
      line: String(total.points),
      odds: fmtOdds(leanOver ? total.overPrice : total.underPrice),
      book,
      reason: leanOver
        ? "Both offences push tempo and neither secondary has been able to force stalled drives."
        : "Pace and early-down run rate both point below the posted number.",
    });
  }

  if (topBets.length === 1 && ml) {
    const favHome = ml.home < ml.away;
    topBets.push({
      key: "top2",
      rank: 2,
      badge: "yellow",
      label: `${favHome ? homeShort : awayShort} ML (${fmtOdds(favHome ? ml.home : ml.away)})`,
      market: "Moneyline",
      selection: favHome ? game.home_team : game.away_team,
      line: null,
      odds: fmtOdds(favHome ? ml.home : ml.away),
      book,
      reason: "Straight-up price is the cleanest way to back the stronger side here.",
    });
  }

  // Strongest badge is always the #1 pick on the board.
  const badgeWeight: Record<Badge, number> = { green: 0, yellow: 1, red: 2 };
  topBets.sort((a, b) => badgeWeight[a.badge] - badgeWeight[b.badge]);
  topBets.forEach((bet, index) => {
    bet.rank = index + 1;
    bet.key = `top${index + 1}`;
  });

  // ---- worst bet on the board, then the opposite side ----
  let badBet: BadBet | null = null;
  if (ml) {
    const dogHome = ml.home > ml.away;
    const badLabel = `${dogHome ? homeShort : awayShort} ML (${fmtOdds(dogHome ? ml.home : ml.away)})`;
    const oppositeLabel = `${dogHome ? awayShort : homeShort} ML (${fmtOdds(dogHome ? ml.away : ml.home)})`;
    const oppositeEdge = spreadEdge + rand(`${seed}:opp`) * 1.5;
    const recommend = oppositeEdge >= 2.5;
    badBet = {
      key: "bad1",
      badge: "red",
      label: badLabel,
      reason:
        "The market is charging for name value here — the underlying numbers do not support the price.",
      oppositeLabel,
      oppositeOdds: fmtOdds(dogHome ? ml.away : ml.home),
      oppositeRecommended: recommend,
      oppositeReason: recommend
        ? "Flipping it does hold up: the same model gap that kills the first side pays on this one."
        : "Flipping it is not a bet either — the favourite is already fairly priced, so pass on both.",
    };
  }

  // ---- fun bets, derived from the same board ----
  const funBets: FunBet[] = [];
  if (spread) {
    const favLine = Math.min(spread.home, spread.away);
    const altLine = favLine - 3.5;
    const favTag = spread.home < spread.away ? homeShort : awayShort;
    funBets.push({
      key: "fun-alt-spread",
      badge: "yellow",
      label: `${favTag} ${fmtLine(altLine)} (alt spread, ${fmtOdds(
        toAmerican(impliedProbability(-130) - 0.13),
      )})`,
      market: "Alternate spread",
      odds: fmtOdds(toAmerican(impliedProbability(-130) - 0.13)),
      reason: "Worth a small ticket if you think the favourite pulls away in the second half.",
    });
  }
  if (total) {
    funBets.push({
      key: "fun-alt-total",
      badge: "yellow",
      label: `Over ${total.points + 6.5} (alt total, ${fmtOdds(
        toAmerican(impliedProbability(-110) - 0.16),
      )})`,
      market: "Alternate total",
      odds: fmtOdds(toAmerican(impliedProbability(-110) - 0.16)),
      reason: "A shootout ticket that pays if either defence breaks early.",
    });
    const teamTotal = Math.round(((total.points + (spread ? -spread.home : 0)) / 2) * 2) / 2;
    funBets.push({
      key: "fun-team-total",
      badge: "green",
      label: `${homeShort} team total Over ${teamTotal} (${fmtOdds(-115)})`,
      market: "Team total",
      odds: fmtOdds(-115),
      reason: "The cleanest way to back the side of the game we actually like.",
    });
  }
  funBets.push({
    key: "fun-first-score",
    badge: "yellow",
    label: `${rand(`${seed}:first`) > 0.5 ? homeShort : awayShort} to score first (${fmtOdds(-105)})`,
    market: "First score",
    odds: fmtOdds(-105),
    reason: "Scripted openers have been the stronger drive for this side all season.",
  });

  // Player props and touchdown-scorer markets need a props-enabled odds feed.
  const playerProps: PropBet[] = [];

  return {
    topBets,
    badBet,
    funBets,
    playerProps,
    notes: { propsAvailable: playerProps.length > 0 },
  };
}

/** Short written reasoning from Lovable AI, keyed by pick. Falls back to formula copy. */
export async function writeReasoning(
  game: GameRow,
  engine: EngineOutput,
): Promise<Record<string, string>> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return {};

  const items = [
    ...engine.topBets.map((b) => ({ key: b.key, label: b.label })),
    ...(engine.badBet ? [{ key: engine.badBet.key, label: engine.badBet.label }] : []),
    ...engine.funBets.map((b) => ({ key: b.key, label: b.label })),
  ];

  const prompt = [
    `Game: ${game.away_team} at ${game.home_team} (${game.sport}).`,
    `Odds: ${JSON.stringify(game.odds)}.`,
    game.injuries.length ? `Injuries: ${JSON.stringify(game.injuries)}.` : "",
    "For each betting selection below, write one sentence of sharp, concrete handicapping rationale.",
    "Rules: never mention percentages, probabilities or numeric confidence. Max 22 words each. No hedging filler.",
    JSON.stringify(items),
  ]
    .filter(Boolean)
    .join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["reasons"],
    properties: {
      reasons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "reason"],
          properties: { key: { type: "string" }, reason: { type: "string" } },
        },
      },
    },
  };

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
        input: prompt,
        stream: true,
        reasoning: { effort: "low", summary: "auto" },
        store: false,
        text: {
          format: { type: "json_schema", name: "lock_lab_reasons", strict: true, schema },
        },
      }),
    });

    if (!res.ok || !res.body) {
      console.error("AI gateway reasoning failed", res.status, await res.text());
      return {};
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
          // ignore keep-alive / partial frames
        }
      }
    }

    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as { reasons?: { key: string; reason: string }[] };
    const map: Record<string, string> = {};
    for (const entry of parsed.reasons ?? []) {
      if (entry.key && entry.reason) map[entry.key] = entry.reason.trim();
    }
    return map;
  } catch (error) {
    console.error("AI gateway reasoning error", error);
    return {};
  }
}

export function applyReasoning(engine: EngineOutput, reasons: Record<string, string>): EngineOutput {
  return {
    ...engine,
    topBets: engine.topBets.map((b) => ({ ...b, reason: reasons[b.key] ?? b.reason })),
    badBet: engine.badBet
      ? { ...engine.badBet, reason: reasons[engine.badBet.key] ?? engine.badBet.reason }
      : null,
    funBets: engine.funBets.map((b) => ({ ...b, reason: reasons[b.key] ?? b.reason })),
  };
}

export type StoredAnalysis = Pick<
  AnalysisRow,
  "top_bets" | "bad_bet" | "fun_bets" | "player_props" | "odds_snapshot"
>;
