/**
 * Live sports data + odds ingestion.
 *
 * Provider: The Odds API (https://the-odds-api.com). The key lives only in the
 * ODDS_API_KEY server secret and is never sent to the browser — every call in
 * this module runs inside server functions / server routes.
 *
 * Nothing in here invents a price. Every number returned comes straight from
 * the provider payload, tagged with the sportsbook it came from and the UTC
 * timestamp at which it was captured.
 */
import type { GameOdds, Injury, MarketOffer, Sport } from "./lock-lab-types";

const PROVIDER_BASE = "https://api.the-odds-api.com/v4";

const SPORT_KEYS: Record<Sport, string> = {
  NFL: "americanfootball_nfl",
  CFB: "americanfootball_ncaaf",
};

const ESPN_SCOREBOARD: Record<Sport, string> = {
  NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  CFB: "https://site.api.espn.com/apis/site/v2/sports/football/college-football/injuries",
};

/** Preferred books, in order. First one present in the payload wins. */
const BOOK_PRIORITY = ["draftkings", "fanduel", "betmgm", "caesars"];

/** Alternate / derivative markets used by the fun-bet section. */
const ALT_MARKETS = ["alternate_spreads", "alternate_totals", "team_totals"];

/** Player prop markets (football). Requires a props-enabled provider plan. */
const PROP_MARKETS = [
  "player_pass_yds",
  "player_pass_tds",
  "player_rush_yds",
  "player_reception_yds",
  "player_receptions",
  "player_first_td",
  "player_anytime_td",
];

export type NormalizedGame = {
  provider_game_id: string;
  sport: Sport;
  home_team: string;
  away_team: string;
  home_team_short: string | null;
  away_team_short: string | null;
  commence_time: string;
  status: "scheduled" | "live" | "final";
  home_score: number | null;
  away_score: number | null;
  odds: GameOdds;
  injuries: Injury[];
  is_demo: boolean;
  odds_book: string | null;
  odds_book_key: string | null;
  odds_updated_at: string;
};

export function getProviderKey(): string | undefined {
  return process.env["ODDS_API_KEY"] || undefined;
}

export function hasProviderKey(): boolean {
  return Boolean(getProviderKey());
}

type ProviderOutcome = { name: string; price: number; point?: number; description?: string };
type ProviderMarket = { key: string; last_update?: string; outcomes: ProviderOutcome[] };
type ProviderBookmaker = {
  key: string;
  title: string;
  last_update?: string;
  markets: ProviderMarket[];
};
type ProviderEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: ProviderBookmaker[];
  completed?: boolean;
  scores?: { name: string; score: string }[] | null;
};

function shortName(team: string) {
  const parts = team.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? team).slice(0, 5).toUpperCase();
}

function pickBook(event: ProviderEvent): ProviderBookmaker | undefined {
  for (const key of BOOK_PRIORITY) {
    const match = event.bookmakers?.find((b) => b.key === key);
    if (match) return match;
  }
  return event.bookmakers?.[0];
}

function normalizeOdds(event: ProviderEvent, capturedAt: string): GameOdds {
  const book = pickBook(event);
  if (!book) return { capturedAt };

  const odds: GameOdds = {
    bookmaker: book.title,
    bookmakerKey: book.key,
    capturedAt: book.last_update ?? capturedAt,
  };

  const spreads = book.markets.find((m) => m.key === "spreads");
  if (spreads) {
    const home = spreads.outcomes.find((o) => o.name === event.home_team);
    const away = spreads.outcomes.find((o) => o.name === event.away_team);
    if (home?.point != null && away?.point != null) {
      odds.spread = {
        home: home.point,
        away: away.point,
        homePrice: home.price,
        awayPrice: away.price,
      };
    }
  }

  const totals = book.markets.find((m) => m.key === "totals");
  if (totals) {
    const over = totals.outcomes.find((o) => o.name.toLowerCase() === "over");
    const under = totals.outcomes.find((o) => o.name.toLowerCase() === "under");
    if (over?.point != null) {
      odds.total = {
        points: over.point,
        overPrice: over.price,
        underPrice: under?.price ?? over.price,
      };
    }
  }

  const ml = book.markets.find((m) => m.key === "h2h");
  if (ml) {
    const home = ml.outcomes.find((o) => o.name === event.home_team);
    const away = ml.outcomes.find((o) => o.name === event.away_team);
    if (home && away) {
      odds.moneyline = { home: home.price, away: away.price };
    }
  }

  return odds;
}

async function providerFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = getProviderKey();
  if (!key) throw new Error("ODDS_API_KEY is not configured");
  const url = new URL(`${PROVIDER_BASE}${path}`);
  url.searchParams.set("apiKey", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    // Never leak the key through an error string.
    throw new Error(`Odds provider ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function fetchUpcomingGames(sport: Sport): Promise<NormalizedGame[]> {
  const events = await providerFetch<ProviderEvent[]>(`/sports/${SPORT_KEYS[sport]}/odds`, {
    regions: "us",
    markets: "h2h,spreads,totals",
    oddsFormat: "american",
  });

  const now = new Date().toISOString();
  return events.map((event) => {
    const odds = normalizeOdds(event, now);
    return {
      provider_game_id: event.id,
      sport,
      home_team: event.home_team,
      away_team: event.away_team,
      home_team_short: shortName(event.home_team),
      away_team_short: shortName(event.away_team),
      commence_time: event.commence_time,
      status: (new Date(event.commence_time) <= new Date() ? "live" : "scheduled") as
        | "live"
        | "scheduled",
      home_score: null,
      away_score: null,
      odds,
      injuries: [],
      is_demo: false,
      odds_book: odds.bookmaker ?? null,
      odds_book_key: odds.bookmakerKey ?? null,
      odds_updated_at: odds.capturedAt ?? now,
    };
  });
}

/** How much of the derivative board the provider actually returned. */
export type MarketCoverage = {
  /** Market keys requested from the provider. */
  requested: string[];
  /** Posted prices received, per market key. */
  received: Record<string, number>;
  /** Sportsbook used for each market key (best available, by priority). */
  books: Record<string, string>;
  /** Market keys the provider returned nothing for. */
  missing: string[];
  /** Provider error text per failed request, if any. */
  errors: string[];
};

/**
 * Per-event alternate lines and player props.
 *
 * The provider returns every US book for the event, but not every book posts
 * every market: DraftKings may price alternate spreads while only FanDuel
 * posts team totals. The book is therefore chosen PER MARKET — the highest
 * priority book that actually posted that market — so a full ladder is never
 * lost because the snapshot book skipped it. Nothing is invented: when no book
 * posts a market it is reported as missing.
 */
export async function fetchEventMarkets(
  sport: Sport,
  providerGameId: string,
): Promise<{
  alternates: MarketOffer[];
  props: MarketOffer[];
  capturedAt: string;
  coverage: MarketCoverage;
}> {
  const capturedAt = new Date().toISOString();
  const coverage: MarketCoverage = {
    requested: [...ALT_MARKETS, ...PROP_MARKETS],
    received: {},
    books: {},
    missing: [],
    errors: [],
  };

  const load = async (markets: string[]) => {
    try {
      return await providerFetch<ProviderEvent>(
        `/sports/${SPORT_KEYS[sport]}/events/${providerGameId}/odds`,
        { regions: "us", oddsFormat: "american", markets: markets.join(",") },
      );
    } catch (error) {
      const message = (error as Error).message;
      coverage.errors.push(`${markets[0]}: ${message}`);
      console.warn(`[odds] event markets unavailable (${markets[0]}):`, message);
      return null;
    }
  };

  /** Best book for one market key: first in priority order that posted it. */
  const bookForMarket = (event: ProviderEvent, marketKey: string) => {
    const withMarket = (event.bookmakers ?? []).filter((b) =>
      (b.markets ?? []).some((m) => m.key === marketKey && (m.outcomes?.length ?? 0) > 0),
    );
    if (!withMarket.length) return undefined;
    for (const key of BOOK_PRIORITY) {
      const match = withMarket.find((b) => b.key === key);
      if (match) return match;
    }
    return withMarket[0];
  };

  const collect = (event: ProviderEvent | null, marketKeys: string[]): MarketOffer[] => {
    const offers: MarketOffer[] = [];
    if (!event?.bookmakers?.length) {
      for (const key of marketKeys) coverage.missing.push(key);
      return offers;
    }
    // Hard game match: never accept markets returned under another event id.
    if (event.id && event.id !== providerGameId) {
      console.warn("[odds] event id mismatch on derivative markets", event.id, providerGameId);
      for (const key of marketKeys) coverage.missing.push(key);
      return offers;
    }

    for (const marketKey of marketKeys) {
      const book = bookForMarket(event, marketKey);
      if (!book) {
        coverage.missing.push(marketKey);
        continue;
      }
      const market = book.markets.find((m) => m.key === marketKey)!;
      coverage.books[marketKey] = book.title;
      let count = 0;
      for (const outcome of market.outcomes ?? []) {
        offers.push({
          market: marketKey,
          selection: outcome.name,
          ...(outcome.description ? { player: outcome.description } : {}),
          point: outcome.point ?? null,
          price: outcome.price,
          book: book.title,
          bookKey: book.key,
          capturedAt: market.last_update ?? book.last_update ?? capturedAt,
          eventId: providerGameId,
          isAlternate: marketKey.startsWith("alternate_"),
        });
        count += 1;
      }
      coverage.received[marketKey] = count;
    }
    return offers;
  };

  // Alternate markets are isolated by key. One unavailable derivative must not
  // erase a spread or total ladder that the provider can return independently.
  // Alternate and player-prop markets are both isolated by key. One
  // unavailable market must never erase the others the provider can serve.
  const [altResults, propResults] = await Promise.all([
    Promise.all(
      ALT_MARKETS.map(async (market) => ({ market, event: await load([market]) })),
    ),
    Promise.all(
      PROP_MARKETS.map(async (market) => ({ market, event: await load([market]) })),
    ),
  ]);
  const alternates = altResults.flatMap(({ market, event }) => collect(event, [market]));
  return {
    alternates,
    props: propResults.flatMap(({ market, event }) => collect(event, [market])),
    capturedAt,
    coverage,
  };
}


export type NormalizedScore = {
  provider_game_id: string;
  sport: Sport;
  status: "scheduled" | "live" | "final";
  home_score: number | null;
  away_score: number | null;
};

export async function fetchScores(sport: Sport, daysFrom = 3): Promise<NormalizedScore[]> {
  const events = await providerFetch<ProviderEvent[]>(`/sports/${SPORT_KEYS[sport]}/scores`, {
    daysFrom: String(daysFrom),
  });

  return events.map((event) => {
    const home = event.scores?.find((s) => s.name === event.home_team);
    const away = event.scores?.find((s) => s.name === event.away_team);
    return {
      provider_game_id: event.id,
      sport,
      status: event.completed
        ? "final"
        : new Date(event.commence_time) <= new Date()
          ? "live"
          : "scheduled",
      home_score: home ? Number.parseInt(home.score, 10) : null,
      away_score: away ? Number.parseInt(away.score, 10) : null,
    };
  });
}

type EspnInjuryFeed = {
  injuries?: {
    displayName?: string;
    injuries?: {
      athlete?: { displayName?: string };
      status?: string;
      details?: { type?: string };
      shortComment?: string;
    }[];
  }[];
};

/** Injury report from ESPN's public feed — no key required, best effort. */
export async function fetchInjuries(sport: Sport): Promise<Map<string, Injury[]>> {
  const byTeam = new Map<string, Injury[]>();
  try {
    const res = await fetch(ESPN_SCOREBOARD[sport]);
    if (!res.ok) return byTeam;
    const feed = (await res.json()) as EspnInjuryFeed;
    for (const team of feed.injuries ?? []) {
      const teamName = team.displayName;
      if (!teamName) continue;
      const list: Injury[] = [];
      for (const item of team.injuries ?? []) {
        const player = item.athlete?.displayName;
        if (!player) continue;
        const note = item.details?.type ?? item.shortComment;
        list.push({
          team: teamName,
          player,
          status: item.status ?? "Unknown",
          ...(note ? { note } : {}),
        });
      }
      if (list.length) byTeam.set(teamName, list.slice(0, 8));
    }
  } catch {
    // Injury data is enrichment only — never block ingestion on it.
  }
  return byTeam;
}
