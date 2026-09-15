export type Sport = "NFL" | "CFB";
export type Badge = "green" | "yellow" | "red";
export type Result = "pending" | "win" | "loss" | "push";

export type GameOdds = {
  bookmaker?: string;
  bookmakerKey?: string;
  /** UTC timestamp at which this snapshot was captured from the provider. */
  capturedAt?: string;
  spread?: { home: number; away: number; homePrice: number; awayPrice: number };
  total?: { points: number; overPrice: number; underPrice: number };
  moneyline?: { home: number; away: number };
};

/** A single real price returned by the provider. Never synthesised. */
export type MarketOffer = {
  market: string;
  selection: string;
  player?: string;
  point: number | null;
  price: number;
  book: string;
  bookKey?: string;
  capturedAt: string;
  /** Provider event id this offer was pulled for — proves game ownership. */
  eventId?: string;
  /** True when this price is an alternate line rather than the standard market. */
  isAlternate?: boolean;
};


/** True when a stored snapshot came from the live provider feed. */
export function hasLiveOdds(odds: GameOdds | null | undefined): boolean {
  return Boolean(odds?.bookmaker && odds?.capturedAt);
}

export function formatCapturedAt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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
  odds_book?: string | null;
  odds_book_key?: string | null;
  odds_updated_at?: string | null;
  props?: MarketOffer[];
  props_updated_at?: string | null;
};

/** Exact price provenance stored with every pick Lock Lab makes. */
export type PickSource = {
  /** Numeric line taken (spread/total/prop point). Null for moneyline. */
  point?: number | null;
  /** American price actually used. */
  price?: number | null;
  book?: string | null;
  bookKey?: string | null;
  /** UTC timestamp of the odds snapshot this pick was priced from. */
  capturedAt?: string | null;
};

export type PickBet = PickSource & {
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
  /** Set when this pick is an alternate line, quoting the standard line it beat. */
  standardLabel?: string | null;
  standardPoint?: number | null;
  standardPrice?: number | null;
  standardBook?: string | null;
  standardCapturedAt?: string | null;
  /** Why the alternate was preferred over that standard line. */
  standardComparison?: string | null;
};

export type BadBet = PickSource & {
  key: string;
  badge: Badge;
  label: string;
  reason: string;
  /** Market of the flagged bet and of its flip side, used by the odds audit. */
  market?: string | null;
  oppositeMarket?: string | null;
  oppositeLabel: string;
  oppositeOdds?: string | null;
  /** Price provenance for the opposite side, so it can be audited too. */
  oppositePoint?: number | null;
  oppositePrice?: number | null;
  oppositeBook?: string | null;
  oppositeCapturedAt?: string | null;
  oppositeRecommended: boolean;
  /** The opposite side is graded on its own merits and can be red. */
  oppositeBadge?: Badge;
  oppositeReason: string;
  /**
   * Same side, better number: when the flagged bet is fixable by moving to an
   * alternate line rather than flipping sides.
   */
  alternateLabel?: string | null;
  alternateOdds?: string | null;
  alternatePoint?: number | null;
  alternatePrice?: number | null;
  alternateBook?: string | null;
  alternateCapturedAt?: string | null;
  alternateBadge?: Badge;
  alternateReason?: string | null;
  alternateRecommended?: boolean;
};


export type FunBet = PickSource & {
  key: string;
  badge: Badge;
  label: string;
  market: string;
  odds?: string | null;
  reason: string;
};

export type PropBet = PickSource & {
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
  odds_captured_at?: string | null;
  odds_book?: string | null;
  is_live_odds?: boolean;
  /** Set when Lock Lab passed on the board instead of posting a top bet. */
  verdict?: string | null;
  top_bets: PickBet[];
  bad_bet: BadBet | null;
  fun_bets: FunBet[];
  player_props: PropBet[];
  /** Internal calibration record; only the line-shopping counts are read by the UI. */
  candidate_audit?: { alternateMarketsReceived?: number | null } | null;
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
