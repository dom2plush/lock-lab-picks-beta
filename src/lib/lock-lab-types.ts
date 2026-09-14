export type Sport = "NFL" | "CFB";
export type Badge = "green" | "yellow" | "red";
export type Result = "pending" | "win" | "loss" | "push";

export type GameOdds = {
  bookmaker?: string;
  spread?: { home: number; away: number; homePrice: number; awayPrice: number };
  total?: { points: number; overPrice: number; underPrice: number };
  moneyline?: { home: number; away: number };
};

export type Injury = {
  team: string;
  player: string;
  status: string;
  note?: string;
};

export type GameRow = {
  id: string;
  sport: Sport;
  provider_game_id: string;
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
};

export type PickBet = {
  key: string;
  rank?: number;
  badge: Badge;
  label: string;
  market: string;
  selection: string;
  line?: string | null;
  odds?: string | null;
  book?: string | null;
  reason: string;
};

export type BadBet = {
  key: string;
  badge: Badge;
  label: string;
  reason: string;
  oppositeLabel: string;
  oppositeOdds?: string | null;
  oppositeRecommended: boolean;
  oppositeReason: string;
};

export type FunBet = {
  key: string;
  badge: Badge;
  label: string;
  market: string;
  odds?: string | null;
  reason: string;
};

export type PropBet = {
  key: string;
  badge: Badge;
  label: string;
  player: string;
  market: string;
  odds?: string | null;
  reason: string;
};

export type AnalysisRow = {
  id: string;
  game_id: string;
  sport: Sport;
  generated_at: string;
  odds_snapshot: GameOdds;
  top_bets: PickBet[];
  bad_bet: BadBet | null;
  fun_bets: FunBet[];
  player_props: PropBet[];
  top_pick_result: Result;
  graded_at: string | null;
};

export const BADGE_LABEL: Record<Badge, string> = {
  green: "Strong bet",
  yellow: "Playable, with concerns",
  red: "Too close — low edge",
};

export const BADGE_DOT: Record<Badge, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

export function teamShort(name: string, short: string | null | undefined) {
  if (short) return short;
  const parts = name.split(" ");
  return parts[parts.length - 1] ?? name;
}

export function matchupLabel(game: Pick<GameRow, "home_team" | "away_team">) {
  return `${game.away_team} at ${game.home_team}`;
}

export function formatKickoff(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
