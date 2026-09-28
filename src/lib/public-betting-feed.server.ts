/**
 * Automatic public-betting splits (ticket % and money %) from Action Network's
 * public scoreboard feed. The odds provider does not publish splits, so this is
 * the source. Percentages are stored for the home side (spread, moneyline) and
 * the over (total). A market the feed does not cover stays blank and is ignored
 * by the model — nothing is ever inferred.
 */
import type { GameRow, Sport } from "./lock-lab-types";

const LEAGUE: Record<Sport, string> = { NFL: "nfl", CFB: "ncaaf" };
const MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

type Outcome = {
  side?: string;
  bet_info?: { money?: { percent?: number }; tickets?: { percent?: number } };
};
type FeedGame = {
  start_time: string;
  home_team_id: number;
  away_team_id: number;
  teams: { id: number; full_name: string }[];
  markets?: Record<string, { event?: Record<string, Outcome[]> }>;
};

export type FeedSplit = {
  home: string;
  away: string;
  start: string;
  spreadBetPct: number | null;
  spreadMoneyPct: number | null;
  mlBetPct: number | null;
  mlMoneyPct: number | null;
  totalBetPct: number | null;
  totalMoneyPct: number | null;
};

export const normTeam = (s: string) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

function pick(outcomes: Outcome[] | undefined, side: string, key: "money" | "tickets") {
  if (!outcomes?.length) return null;
  const total = outcomes.reduce((a, o) => a + (o.bet_info?.[key]?.percent ?? 0), 0);
  if (!total) return null; // feed has no split for this market
  const v = outcomes.find((o) => o.side === side)?.bet_info?.[key]?.percent;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseFeed(json: { games?: FeedGame[] }): FeedSplit[] {
  const out: FeedSplit[] = [];
  for (const g of json.games ?? []) {
    const name = (id: number) => g.teams.find((t) => t.id === id)?.full_name;
    const home = name(g.home_team_id);
    const away = name(g.away_team_id);
    if (!home || !away) continue;
    // Splits are consensus figures; take the first book that carries them.
    const books = Object.values(g.markets ?? {});
    const market = (type: string) =>
      books.map((b) => b.event?.[type]).find((o) => pick(o, o?.[0]?.side ?? "", "tickets") != null);
    const spread = market("spread");
    const ml = market("moneyline");
    const total = market("total");
    out.push({
      home,
      away,
      start: g.start_time,
      spreadBetPct: pick(spread, "home", "tickets"),
      spreadMoneyPct: pick(spread, "home", "money"),
      mlBetPct: pick(ml, "home", "tickets"),
      mlMoneyPct: pick(ml, "home", "money"),
      totalBetPct: pick(total, "over", "tickets"),
      totalMoneyPct: pick(total, "over", "money"),
    });
  }
  return out;
}

export async function fetchSplits(sport: Sport): Promise<FeedSplit[]> {
  const url = `https://api.actionnetwork.com/web/v2/scoreboard/${LEAGUE[sport]}?bookIds=15,30,68,69,71&periods=event`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`splits feed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseFeed(await res.json());
}

export function matchSplit(game: Pick<GameRow, "home_team" | "away_team" | "commence_time">, splits: FeedSplit[]) {
  const h = normTeam(game.home_team);
  const a = normTeam(game.away_team);
  const t = new Date(game.commence_time).getTime();
  return (
    splits.find(
      (s) =>
        normTeam(s.home) === h &&
        normTeam(s.away) === a &&
        Math.abs(new Date(s.start).getTime() - t) < MATCH_WINDOW_MS,
    ) ?? null
  );
}

const hasAny = (s: FeedSplit) =>
  [s.spreadBetPct, s.spreadMoneyPct, s.mlBetPct, s.mlMoneyPct, s.totalBetPct, s.totalMoneyPct].some(
    (v) => v != null,
  );

/** Stores splits for the given games. Returns how many games got a split. */
export async function storeSplits(games: GameRow[], splits: FeedSplit[]): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();
  const rows = games
    .map((g) => ({ g, s: matchSplit(g, splits) }))
    .filter((x): x is { g: GameRow; s: FeedSplit } => !!x.s && hasAny(x.s))
    .map(({ g, s }) => ({
      game_id: g.id,
      spread_bet_pct: s.spreadBetPct,
      spread_money_pct: s.spreadMoneyPct,
      ml_bet_pct: s.mlBetPct,
      ml_money_pct: s.mlMoneyPct,
      total_bet_pct: s.totalBetPct,
      total_money_pct: s.totalMoneyPct,
      recorded_at: now,
      updated_at: now,
      updated_by: null,
    }));
  if (!rows.length) return 0;
  const { error } = await supabaseAdmin
    .from("public_betting_inputs")
    .upsert(rows as never, { onConflict: "game_id" });
  if (error) throw new Error(error.message);
  return rows.length;
}

/** Refreshes splits for one game alongside its odds. Never throws. */
export async function refreshGameSplits(game: GameRow): Promise<void> {
  try {
    await storeSplits([game], await fetchSplits(game.sport));
  } catch (error) {
    console.error("[splits] single-game refresh failed", (error as Error).message);
  }
}
