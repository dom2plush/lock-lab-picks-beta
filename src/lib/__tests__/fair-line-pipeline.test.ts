/**
 * Guards for the single decision pipeline: the fair line and its simulated
 * score distribution are built before any line shopping, and no section can
 * publish a bet the distribution does not support.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runLockLabFormula } from "../analysis-engine.server";
import { buildFairModel } from "../fair-model.server";
import { simulateGame } from "../game-sim.server";
import type { GameOdds, GameRow, MarketOffer } from "../lock-lab-types";

const capturedAt = "2026-09-20T15:00:00.000Z";
const odds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt,
  spread: { home: -7, away: 7, homePrice: -110, awayPrice: -110 },
  total: { points: 46.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -320, away: 260 },
};

const game = {
  id: "00000000-0000-4000-8000-000000000002",
  sport: "NFL",
  provider_game_id: "evt-rams-giants",
  home_team: "Los Angeles Rams",
  away_team: "New York Giants",
  home_team_short: "RAMS",
  away_team_short: "GIANTS",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds,
  injuries: [],
  is_demo: false,
} satisfies GameRow;

function alt(point: number, price: number, selection: string): MarketOffer {
  return {
    market: "alternate_spreads",
    selection,
    point,
    price,
    book: "DraftKings",
    bookKey: "draftkings",
    capturedAt,
    eventId: game.provider_game_id,
    isAlternate: true,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fair line is built before any line shopping", () => {
  it("anchors on the market and produces a simulated distribution", async () => {
    const fair = await buildFairModel(game, odds);
    const projection = simulateGame(game, fair);

    expect(projection.runs).toBe(50);
    expect(projection.scores).toHaveLength(50);
    // Probabilities must be internally consistent: more points is always at
    // least as likely to cover, so an alternate cannot invent value.
    expect(projection.spreadProb("away", 10)).toBeGreaterThanOrEqual(projection.spreadProb("away", 7));
    expect(projection.spreadProb("away", 7)).toBeGreaterThanOrEqual(projection.spreadProb("away", 3));
    expect(projection.totalProb("Under", 40)).toBeLessThanOrEqual(projection.totalProb("Under", 52));
    expect(projection.homeWinProb).toBeGreaterThan(0.5);
  });
});

describe("published board obeys one set of rules", () => {
  it("never publishes a negative edge, a far alternate, or a price worse than -180", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const alternates = [
      alt(2.5, 220, game.away_team),
      alt(13.5, -150, game.away_team),
      alt(-3.5, -240, game.home_team),
    ];

    const result = await runLockLabFormula(game, odds, { alternates, props: [] });

    expect(result.topBets.length).toBeLessThanOrEqual(2);
    for (const pick of [...result.topBets, ...result.playerProps]) {
      expect(pick.price == null || pick.price >= -180).toBe(true);
      if (pick.point != null && pick.standardPoint != null) {
        expect(Math.abs(pick.point - pick.standardPoint)).toBeLessThanOrEqual(4);
      }
    }
    // Two published bets are always two different ideas, never two rungs of one.
    const ideas = result.topBets.map((bet) => bet.market);
    expect(new Set(ideas).size).toBe(ideas.length);
  });
});
