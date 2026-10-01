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

/**
 * Manually entered public-betting split for one game. Every field is optional:
 * a blank field is ignored entirely and never inferred. Percentages describe
 * the HOME side (spread, moneyline) and the OVER (total).
 */
export type PublicBetting = {
  spreadBetPct?: number | null;
  spreadMoneyPct?: number | null;
  mlBetPct?: number | null;
  mlMoneyPct?: number | null;
  totalBetPct?: number | null;
  totalMoneyPct?: number | null;
  /** When the entered split was observed. */
  recordedAt?: string | null;
  updatedAt?: string | null;
};

/** True when at least one public-betting figure was actually entered. */
export function hasPublicBetting(p: PublicBetting | null | undefined): boolean {
  if (!p) return false;
  return [
    p.spreadBetPct,
    p.spreadMoneyPct,
    p.mlBetPct,
    p.mlMoneyPct,
    p.totalBetPct,
    p.totalMoneyPct,
  ].some((v) => typeof v === "number" && Number.isFinite(v));
}

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
  updated_at?: string | null;
  /** Optional manual public-betting split; absent/blank means "ignore". */
  public_betting?: PublicBetting | null;
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
  /** Internal: the graded board selection this pick was published from. */
  candidateKey?: string | null;
  /** Number of simulated games this pick was settled against (always 100). */
  simRuns?: number | null;
  /** Run numbers (1-based) this pick won in those simulated games. */
  simHits?: number[] | null;
  /** Share of the 100 simulated games this pick won, stored with the pick. */
  simHitRate?: number | null;
  /** Simulated hit rate minus the probability the stored price implies. */
  modelEdge?: number | null;
  /** Expected return per unit staked at the stored price, from the simulation. */
  expectedRoi?: number | null;
  /** Base Model (runs 1-500) hit rate. */
  baseHitRate?: number | null;
  /** Stress Test (runs 501-1000) hit rate. */
  stressHitRate?: number | null;
  /** All 1,000 runs. */
  combinedHitRate?: number | null;
  baseEdge?: number | null;
  stressEdge?: number | null;
  combinedEdge?: number | null;
  /** Break-even probability of the stored price. */
  impliedProbability?: number | null;
  /** 0-1 closeness of the Base and Stress hit rates. */
  agreementScore?: number | null;
  agreementLevel?: "HIGH" | "MEDIUM" | "LOW" | null;
  /** Real model components behind the edge, in points toward this bet. */
  whyComponents?: { label: string; points: number }[] | null;
  /** Set when Lock Lab disagrees with the market by an unusually wide margin. */
  disagreement?: { model: number; market: number; verdict: "supported" | "weakened" | "uncertain" } | null;
  /** Standard-line metrics when an alternate line was chosen over it. */
  standardMetrics?: { hitRate: number; implied: number; edge: number; roi: number; pushRate?: number | null } | null;
  /** Push share of the 1,000 runs (spreads/totals on whole numbers). */
  pushRate?: number | null;
};

export type PickBet = PickSource & {
  key: string;
  rank?: number;
  /** Standard-market side (e.g. spread-home, total-over); used only for the split-based badge read. */
  sideKey?: string | null;
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

export type FunBet = PickSource & {
  key: string;
  badge: Badge;
  label: string;
  player?: string;
  market: string;
  odds?: string | null;
  /** Formula-estimated probability used to validate the posted price. */
  estimatedProbability?: number | null;
  reason: string;
};

export type PropBet = PickSource & {
  key: string;
  badge: Badge;
  label: string;
  player: string;
  market: string;
  odds?: string | null;
  /** Formula-estimated probability used to validate the posted price. */
  estimatedProbability?: number | null;
  reason: string;
  /** Set on touchdown picks, which are shown in their own section. */
  touchdown?: boolean;
  /** Team this touchdown pick belongs to, when the report can prove it. */
  team?: string | null;
};

/** Touchdown picks are stored inside player_props and split out by key. */
export function isTouchdownPick(pick: { key: string; touchdown?: boolean }): boolean {
  return pick.touchdown === true || String(pick.key).startsWith("td-");
}

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
  /** Legacy column retained for old saved rows; new analyses always store null. */
  bad_bet: null;
  /** Legacy storage field retained for old saved cards; new analyses store []. */
  fun_bets: FunBet[];
  player_props: PropBet[];
  /** Internal calibration record; only the line-shopping counts are read by the UI. */
  candidate_audit?: { alternateMarketsReceived?: number | null } | null;
  top_pick_result: Result;
  graded_at: string | null;
  /** The stored 100-run batch this card came from. */
  simulation_id?: string | null;
};

export const BADGE_LABEL: Record<Badge, string> = {
  green: "Robust edge",
  yellow: "Fragile / lean edge",
  red: "No edge",
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
