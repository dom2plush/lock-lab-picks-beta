/**
 * Player-level outcomes inside the SAME 50 simulated games.
 *
 * The 50 game scores produced by {@link simulateGame} are the only source of
 * game state here. For every verified posted player prop, this module draws a
 * stat line inside each of those 50 games, correlated with that game's team
 * score, total and margin (game script), so a player's markets can never
 * contradict each other or the score the game was simulated at.
 *
 * Rules:
 *  - The sportsbook's posted number is used ONLY to calibrate a player's
 *    workload baseline. It never sets the probability: the probability is the
 *    count of simulated games in which the stat cleared the line.
 *  - Nothing is invented. A player with no usable posted baseline, or a market
 *    with no simulated stat, returns null and the caller falls back to its
 *    existing market-derived estimate.
 */
import type { GameProjection } from "./game-sim.server";
import type { GameRow, MarketOffer } from "./lock-lab-types";
import { mulberry32, seedFrom } from "./simulation.server";

/** Yardage scatter (coefficient of variation) by market. */
const YARD_CV: Record<string, number> = {
  player_pass_yds: 0.24,
  player_rush_yds: 0.45,
  player_reception_yds: 0.5,
  // Workload counts with large lines scatter far less than yardage.
  player_pass_completions: 0.18,
  player_pass_attempts: 0.15,
  player_rush_attempts: 0.3,
};

const COUNT_MARKETS = new Set(["player_receptions", "player_pass_tds", "player_pass_interceptions"]);
const PASS_SCRIPT_MARKETS = new Set([
  "player_pass_yds",
  "player_reception_yds",
  "player_receptions",
  "player_pass_completions",
  "player_pass_attempts",
]);
const RUSH_SCRIPT_MARKETS = new Set(["player_rush_yds", "player_rush_attempts"]);
const TD_MARKETS = new Set(["player_anytime_td", "player_1st_td"]);

export type PropQuery = {
  market: string;
  player?: string | undefined;
  selection: string;
  point: number | null;
};

export type PlayerProjection = {
  runs: number;
  available: boolean;
  notes: string[];
  /** Per-run win/lose vector for a posted prop, or null when unsupported. */
  outcomes(query: PropQuery): boolean[] | null;
  /** Simulated hit rate for a posted prop, or null when unsupported. */
  probability(query: PropQuery): number | null;
};

const EMPTY: PlayerProjection = {
  runs: 0,
  available: false,
  notes: [
    "PLAYER SIMULATION UNAVAILABLE: no simulated game scores or no verified posted player props, so no player-level distribution exists.",
  ],
  outcomes: () => null,
  probability: () => null,
};

function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function impliedProbability(price: number): number | null {
  if (!Number.isFinite(price) || price === 0) return null;
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Inverse-CDF Poisson draw, so the count stays correlated with the same u. */
function poisson(lambda: number, u: number): number {
  const mean = Math.max(0.01, lambda);
  let p = Math.exp(-mean);
  let cumulative = p;
  let k = 0;
  const target = clamp(u, 1e-6, 1 - 1e-6);
  while (cumulative < target && k < 30) {
    k += 1;
    p = (p * mean) / k;
    cumulative += p;
  }
  return k;
}

type PlayerMarketBaseline = {
  /** Median posted rung: a real number the book offered, never interpolated. */
  line: number | null;
  /** Vig-stripped chance the market gives the "yes"/"over" side. */
  yesProbability: number | null;
};

type PlayerModel = {
  player: string;
  team: string | null;
  markets: Map<string, PlayerMarketBaseline>;
};

/** Only the supplied injury report can attribute a player to a team. */
function teamOf(game: GameRow, player: string): string | null {
  const wanted = player.trim().toLowerCase();
  for (const injury of game.injuries ?? []) {
    if ((injury.player ?? "").trim().toLowerCase() === wanted) {
      if (injury.team === game.home_team) return game.home_team;
      if (injury.team === game.away_team) return game.away_team;
    }
  }
  return null;
}

/** Touchdowns a team plausibly scored given its simulated points. */
function touchdownsFor(points: number): number {
  return Math.max(0, Math.round((points - 2.5) / 7.4));
}

export function simulatePlayers(
  game: GameRow,
  projection: GameProjection,
  offers: MarketOffer[],
): PlayerProjection {
  const scores = projection.scores;
  if (!scores.length || !offers.length) return EMPTY;

  // ---- Baselines, calibrated from real posted rungs only -------------------
  const models = new Map<string, PlayerModel>();
  const rungs = new Map<string, number[]>();
  const yesPrices = new Map<string, number[]>();

  for (const offer of offers) {
    const player = (offer.player ?? "").trim();
    if (!player) continue;
    const side = (offer.selection ?? "").trim().toLowerCase();
    const id = `${player}|${offer.market}`;
    if (offer.point != null) rungs.set(id, [...(rungs.get(id) ?? []), offer.point]);
    if (side === "over" || side === "yes") {
      yesPrices.set(id, [...(yesPrices.get(id) ?? []), offer.price]);
    }
    if (!models.has(player)) {
      models.set(player, { player, team: teamOf(game, player), markets: new Map() });
    }
    models.get(player)!.markets.set(offer.market, { line: null, yesProbability: null });
  }

  for (const model of models.values()) {
    for (const [market] of model.markets) {
      const id = `${model.player}|${market}`;
      const prices = yesPrices.get(id) ?? [];
      const bestYes = prices.length ? Math.max(...prices.map((p) => impliedProbability(p) ?? 0)) : 0;
      model.markets.set(market, {
        line: median(rungs.get(id) ?? []),
        // Single-sided scorer markets carry roughly 8% hold at book level.
        yesProbability: bestYes > 0 ? clamp(bestYes / 1.08, 0.01, 0.95) : null,
      });
    }
  }

  const fairTotal = projection.fairTotal ?? null;
  const fairMargin = projection.fairMargin ?? null;
  const expHome = fairTotal != null && fairMargin != null ? (fairTotal + fairMargin) / 2 : null;
  const expAway = fairTotal != null && fairMargin != null ? (fairTotal - fairMargin) / 2 : null;

  const seedBase = `${game.id}:${game.odds?.capturedAt ?? game.odds_updated_at ?? ""}:players`;

  // ---- One stat line per player per simulated game -------------------------
  type Stats = { value: Map<string, number>; anyTd: boolean; firstTd: boolean };
  const perRun: Map<string, Stats>[] = [];

  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index]!;
    const run = index + 1;
    const runStats = new Map<string, Stats>();

    const gameFactor =
      fairTotal && fairTotal > 0 ? clamp(score.total / fairTotal, 0.6, 1.5) : 1;

    for (const model of models.values()) {
      const isHome = model.team === game.home_team;
      const isAway = model.team === game.away_team;
      const teamScore = isHome ? score.home : isAway ? score.away : null;
      const oppScore = isHome ? score.away : isAway ? score.home : null;
      const expected = isHome ? expHome : isAway ? expAway : null;

      // Scoring environment and game script, both read off this simulated game.
      const scoreFactor =
        teamScore != null && expected != null && expected > 0
          ? clamp(teamScore / expected, 0.55, 1.6)
          : gameFactor;
      const deficit = teamScore != null && oppScore != null ? oppScore - teamScore : 0;
      const passFactor = clamp(1 + deficit * 0.012, 0.85, 1.22);
      const rushFactor = clamp(1 - deficit * 0.012, 0.78, 1.18);

      // One performance draw per player per simulated game keeps that player's
      // own markets consistent with each other inside the same game.
      const z = gaussian(mulberry32(seedFrom(`${seedBase}:${model.player}:${run}`)));
      const u = normalCdf(z);

      const value = new Map<string, number>();
      for (const [market, baseline] of model.markets) {
        if (TD_MARKETS.has(market)) continue;
        const line = baseline.line;
        if (line == null || line <= 0) continue;
        const script = RUSH_SCRIPT_MARKETS.has(market)
          ? rushFactor
          : PASS_SCRIPT_MARKETS.has(market)
            ? passFactor
            : 1;
        const mean = line * scoreFactor * script;
        if (COUNT_MARKETS.has(market)) {
          const lambda = market === "player_pass_tds" ? mean + 0.15 : mean + 0.1;
          value.set(market, poisson(lambda, u));
        } else {
          const cv = YARD_CV[market] ?? 0.4;
          const sigma = Math.sqrt(Math.log(1 + cv * cv));
          // The posted rung is treated as the player's median outcome, so the
          // skew of the yardage distribution cannot bias every prop to the under.
          value.set(market, Math.max(0, mean * Math.exp(sigma * z)));
        }
      }

      // Realism guard: no receiving yards in a game with no catches.
      if (value.get("player_receptions") === 0) value.set("player_reception_yds", 0);

      runStats.set(model.player, { value, anyTd: false, firstTd: false });
    }

    // ---- Touchdown allocation: scorers come out of the simulated score -----
    const scorerPool = [...models.values()].filter((m) => m.markets.has("player_anytime_td") || m.markets.has("player_1st_td"));
    if (scorerPool.length) {
      const groups: { players: PlayerModel[]; touchdowns: number }[] = [];
      const homePool = scorerPool.filter((m) => m.team === game.home_team);
      const awayPool = scorerPool.filter((m) => m.team === game.away_team);
      const unknown = scorerPool.filter((m) => m.team == null);
      if (homePool.length) groups.push({ players: homePool, touchdowns: touchdownsFor(score.home) });
      if (awayPool.length) groups.push({ players: awayPool, touchdowns: touchdownsFor(score.away) });
      if (unknown.length) {
        groups.push({
          players: unknown,
          touchdowns: touchdownsFor(score.home) + touchdownsFor(score.away),
        });
      }

      const order: string[] = [];
      for (const group of groups) {
        const rand = mulberry32(seedFrom(`${seedBase}:td:${group.players[0]!.player}:${run}`));
        const remaining = group.players.map((m) => ({
          player: m.player,
          weight: Math.max(
            0.01,
            m.markets.get("player_anytime_td")?.yesProbability ??
              m.markets.get("player_1st_td")?.yesProbability ??
              0.05,
          ),
        }));
        // Draw distinct scorers without replacement, weighted by the market's
        // own read of how likely each player is to find the end zone.
        const slots = Math.min(group.touchdowns, remaining.length);
        for (let slot = 0; slot < slots; slot += 1) {
          const total = remaining.reduce((sum, r) => sum + r.weight, 0);
          if (total <= 0) break;
          let ticket = rand() * total;
          let chosen = remaining.length - 1;
          for (let i = 0; i < remaining.length; i += 1) {
            ticket -= remaining[i]!.weight;
            if (ticket <= 0) {
              chosen = i;
              break;
            }
          }
          const [winner] = remaining.splice(chosen, 1);
          if (!winner) break;
          const stats = runStats.get(winner.player);
          if (stats) stats.anyTd = true;
          order.push(winner.player);
        }
      }

      if (order.length) {
        // First touchdown of the game: one scorer, drawn from the players who
        // actually scored in this simulated game.
        const rand = mulberry32(seedFrom(`${seedBase}:firsttd:${run}`));
        const first = order[Math.min(order.length - 1, Math.floor(rand() * order.length))]!;
        const stats = runStats.get(first);
        if (stats) stats.firstTd = true;
      }
    }

    perRun.push(runStats);
  }

  const runs = perRun.length;

  function outcomes(query: PropQuery): boolean[] | null {
    const player = (query.player ?? "").trim();
    if (!player) return null;
    const model = models.get(player);
    if (!model) return null;
    const side = (query.selection ?? "").trim().toLowerCase();

    if (TD_MARKETS.has(query.market)) {
      if (!model.markets.has(query.market)) return null;
      const wantYes = side === "yes" || side === "over";
      const wantNo = side === "no" || side === "under";
      if (!wantYes && !wantNo) return null;
      return perRun.map((stats) => {
        const entry = stats.get(player);
        const scored = query.market === "player_1st_td" ? Boolean(entry?.firstTd) : Boolean(entry?.anyTd);
        return wantYes ? scored : !scored;
      });
    }

    if (query.point == null) return null;
    const baseline = model.markets.get(query.market);
    if (!baseline || baseline.line == null) return null;
    const over = side === "over";
    const under = side === "under";
    if (!over && !under) return null;
    let simulated = false;
    const result = perRun.map((stats) => {
      const value = stats.get(player)?.value.get(query.market);
      if (value == null) return false;
      simulated = true;
      // A push is not a win; it is counted honestly against the 50 runs.
      return over ? value > query.point! : value < query.point!;
    });
    return simulated ? result : null;
  }

  function probability(query: PropQuery): number | null {
    const result = outcomes(query);
    if (!result || !result.length) return null;
    const wins = result.filter(Boolean).length;
    return clamp(wins / result.length, 0.02, 0.98);
  }

  const notes = [
    `Player stats simulated inside the same ${runs} game scores for ${models.size} posted player${models.size === 1 ? "" : "s"}: workload calibrated to the posted line, then scaled by each simulated game's team score and game script. Prop hit rates are counts out of those ${runs} runs, not independent coin flips.`,
  ];

  return { runs, available: true, notes, outcomes, probability };
}
