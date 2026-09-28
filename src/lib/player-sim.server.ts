/**
 * Player-level outcomes inside the SAME 100 simulated games.
 *
 * The 100 game scores produced by {@link simulateGame} are the only source of
 * game state here. For every verified posted player prop, this module draws a
 * stat line inside each of those 100 games, correlated with that game's team
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
/**
 * Multi-touchdown rungs (2+ TDs) are not modelled by the per-player stat draw,
 * so they return no simulated outcome and fall back to the posted price.
 */
const UNSIMULATED_MARKETS = new Set(["player_tds_over"]);

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
  /** 0-1 workload share from the verified injury report. */
  availability: number;
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

const OUT_STATUS = /\bout\b|injured reserve|\bir\b|suspend|inactive|\bpup\b|\bnfi\b/i;
const DOUBTFUL_STATUS = /doubtful/i;
const QUESTIONABLE_STATUS = /questionable|game[- ]time/i;

/**
 * Workload multiplier from the VERIFIED injury report only. A player who is
 * ruled out does not accumulate stats in any simulated game; a doubtful or
 * questionable player carries reduced snaps. A player who is not on the report
 * is simulated at full workload, and the absence of a report is handled by the
 * fair model's confidence, never by silently assuming health here.
 */
function availabilityFactor(game: GameRow, player: string): number {
  const wanted = player.trim().toLowerCase();
  for (const injury of game.injuries ?? []) {
    if ((injury.player ?? "").trim().toLowerCase() !== wanted) continue;
    const status = String(injury.status ?? "");
    if (OUT_STATUS.test(status)) return 0;
    if (DOUBTFUL_STATUS.test(status)) return 0.3;
    if (QUESTIONABLE_STATUS.test(status)) return 0.85;
  }
  return 1;
}

/** Touchdowns a team plausibly scored given its simulated points. */
function touchdownsFor(points: number): number {
  return Math.max(0, Math.round((points - 2.5) / 7.4));
}

/**
 * Convert an Anytime-TD game probability into a per-touchdown scorer chance.
 * Repeated touchdown opportunities then reproduce the posted baseline without
 * forcing every team touchdown onto the small set of players whose markets
 * happened to be returned by the sportsbook.
 */
function scorerChancePerTouchdown(gameProbability: number, expectedTouchdowns: number): number {
  const chances = Math.max(1, expectedTouchdowns);
  // A single listed player cannot own more than three quarters of a team's TD
  // probability. Prices beyond that are treated as uncertainty/hold, not as a
  // licence to create 80%+ scorer rates from a thin posted pool.
  return clamp(1 - Math.pow(1 - clamp(gameProbability, 0.01, 0.75), 1 / chances), 0.001, 0.75);
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
      models.set(player, {
        player,
        team: teamOf(game, player),
        availability: availabilityFactor(game, player),
        markets: new Map(),
      });
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
        if (TD_MARKETS.has(market) || UNSIMULATED_MARKETS.has(market)) continue;
        const line = baseline.line;
        if (line == null || line <= 0) continue;
        const script = RUSH_SCRIPT_MARKETS.has(market)
          ? rushFactor
          : PASS_SCRIPT_MARKETS.has(market)
            ? passFactor
            : 1;
        // Verified availability scales the workload: a player ruled out scores
        // nothing in any simulated game, a doubtful one plays limited snaps.
        const mean = line * scoreFactor * script * model.availability;
        if (model.availability <= 0) {
          value.set(market, 0);
          continue;
        }
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
      const groups: { id: string; players: PlayerModel[]; touchdowns: number; expectedTouchdowns: number }[] = [];
      const homePool = scorerPool.filter((m) => m.team === game.home_team);
      const awayPool = scorerPool.filter((m) => m.team === game.away_team);
      const unknown = scorerPool.filter((m) => m.team == null);
      if (homePool.length) groups.push({
        id: "home",
        players: homePool,
        touchdowns: touchdownsFor(score.home),
        expectedTouchdowns: touchdownsFor(expHome ?? score.home),
      });
      if (awayPool.length) groups.push({
        id: "away",
        players: awayPool,
        touchdowns: touchdownsFor(score.away),
        expectedTouchdowns: touchdownsFor(expAway ?? score.away),
      });
      if (unknown.length) {
        groups.push({
          id: "unknown",
          players: unknown,
          touchdowns: touchdownsFor(score.home) + touchdownsFor(score.away),
          expectedTouchdowns: touchdownsFor((expHome ?? score.home) + (expAway ?? score.away)),
        });
      }

      const touchdownSlots = groups.flatMap((group) =>
        Array.from({ length: group.touchdowns }, (_, slot) => ({ group, slot })),
      );
      const orderRand = mulberry32(seedFrom(`${seedBase}:td-order:${run}`));
      for (let i = touchdownSlots.length - 1; i > 0; i -= 1) {
        const j = Math.floor(orderRand() * (i + 1));
        [touchdownSlots[i], touchdownSlots[j]] = [touchdownSlots[j]!, touchdownSlots[i]!];
      }

      let firstTouchdownAssigned = false;
      for (const { group, slot } of touchdownSlots) {
        const rand = mulberry32(seedFrom(`${seedBase}:td:${group.id}:${run}:${slot}`));
        const available = group.players
          .filter((m) => m.availability > 0)
          .map((m) => ({
            player: m.player,
            chance:
              (!firstTouchdownAssigned && m.markets.get("player_1st_td")?.yesProbability != null
                ? clamp(m.markets.get("player_1st_td")?.yesProbability ?? 0, 0.001, 0.45)
                : m.markets.get("player_anytime_td")?.yesProbability != null
                  ? scorerChancePerTouchdown(
                      m.markets.get("player_anytime_td")?.yesProbability ?? 0,
                      group.expectedTouchdowns,
                    )
                  : 0) * m.availability,
          }));

        // The unlisted field keeps a small sportsbook subset from absorbing
        // every simulated touchdown. If listed chances exceed one slot, scale
        // them together rather than inflating any individual player.
        const listedTotal = available.reduce((sum, player) => sum + player.chance, 0);
        const scale = listedTotal > 0.92 ? 0.92 / listedTotal : 1;
        let ticket = rand();
        let winner: string | null = null;
        for (const player of available) {
          ticket -= player.chance * scale;
          if (ticket <= 0) {
            winner = player.player;
            break;
          }
        }
        if (winner) {
          const stats = runStats.get(winner);
          if (stats) {
            stats.anyTd = true;
            if (!firstTouchdownAssigned) stats.firstTd = true;
          }
        }
        // The first touchdown can belong to the unlisted field. In that case,
        // every posted First-TD player correctly loses this simulation.
        firstTouchdownAssigned = true;
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
      // A push is not a win; it is counted honestly against the 100 runs.
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

  const limited = [...models.values()].filter((m) => m.availability < 1);
  const notes = [
    `Player stats simulated inside the same ${runs} game scores for ${models.size} posted player${models.size === 1 ? "" : "s"}: workload calibrated to the posted line, then scaled by each simulated game's team score and game script. Touchdown chances retain an unlisted-field share and allow repeat scorers. Prop hit rates are counts out of those ${runs} runs, not independent coin flips.`,
  ];
  if (limited.length) {
    notes.push(
      `Verified availability applied: ${limited
        .map((m) => `${m.player} at ${(m.availability * 100).toFixed(0)}% workload`)
        .join(", ")}.`,
    );
  }


  return { runs, available: true, notes, outcomes, probability };
}
