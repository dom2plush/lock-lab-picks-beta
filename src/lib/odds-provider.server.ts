/**
 * Live sports data + odds ingestion.
 *
 * Provider: The Odds API (https://the-odds-api.com) or any provider that mirrors
 * its response shape. Plug a key in as the ODDS_API_KEY secret and the pipeline
 * takes over automatically; until then the seeded demo schedule stays in place
 * and nothing is overwritten.
 */
import type { GameOdds, Injury, Sport } from "./lock-lab-types";

const PROVIDER_BASE = "https://api.the-odds-api.com/v4";

const SPORT_KEYS: Record<Sport, string> = {
  NFL: "americanfootball_nfl",
  CFB: "americanfootball_ncaaf",
};

const ESPN_SCOREBOARD: Record<Sport, string> = {
  NFL: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  CFB: "https://site.api.espn.com/apis/site/v2/sports/football/college-football/injuries",
};

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
  odds_updated_at: string;
};

export function getProviderKey(): string | undefined {
  return process.env["ODDS_API_KEY"] || undefined;
}

export function hasProviderKey(): boolean {
  return Boolean(getProviderKey());
}

type ProviderOutcome = { name: string; price: number; point?: number };
type ProviderMarket = { key: string; outcomes: ProviderOutcome[] };
type ProviderBookmaker = { key: string; title: string; markets: ProviderMarket[] };
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

function normalizeOdds(event: ProviderEvent): GameOdds {
  const book =
    event.bookmakers?.find((b) => ["draftkings", "fanduel"].includes(b.key)) ??
    event.bookmakers?.[0];
  if (!book) return {};

  const odds: GameOdds = { bookmaker: book.title };

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
  return events.map((event) => ({
    provider_game_id: event.id,
    sport,
    home_team: event.home_team,
    away_team: event.away_team,
    home_team_short: shortName(event.home_team),
    away_team_short: shortName(event.away_team),
    commence_time: event.commence_time,
    status: new Date(event.commence_time) <= new Date() ? "live" : "scheduled",
    home_score: null,
    away_score: null,
    odds: normalizeOdds(event),
    injuries: [],
    is_demo: false,
    odds_updated_at: now,
  }));
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
