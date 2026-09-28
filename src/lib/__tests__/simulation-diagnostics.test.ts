/**
 * The 100-run engine must expose auditable diagnostics and a genuinely wide
 * scoring distribution: one shared set of simulated scores prices every
 * market, and totals must not pile up on the posted number.
 */
import { describe, expect, it } from "vitest";

import { buildFairModel } from "../fair-model.server";
import { simulateGame } from "../game-sim.server";
import type { GameOdds, GameRow } from "../lock-lab-types";

const capturedAt = "2026-09-20T15:00:00.000Z";
const odds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt,
  spread: { home: -3, away: 3, homePrice: -110, awayPrice: -110 },
  total: { points: 45.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -160, away: 140 },
};

const game = {
  id: "00000000-0000-4000-8000-000000000055",
  sport: "NFL",
  provider_game_id: "evt-diagnostics",
  home_team: "Chicago Bears",
  away_team: "Philadelphia Eagles",
  home_team_short: "BEARS",
  away_team_short: "EAGLES",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds,
  injuries: [],
  is_demo: false,
} satisfies GameRow;

describe("100-run simulation diagnostics", () => {
  it("reports average, median, variance, win counts and the total distribution", async () => {
    const fair = await buildFairModel(game, odds);
    const projection = simulateGame(game, fair);
    const d = projection.diagnostics!;

    expect(projection.runs).toBe(100);
    expect(d.runs).toBe(100);
    expect(d.homeWins + d.awayWins + d.ties).toBe(100);
    expect(d.avgTotal).toBeGreaterThan(20);
    expect(d.medianTotal).toBeGreaterThan(20);
    expect(d.totalDistribution.reduce((sum, band) => sum + band.runs, 0)).toBe(100);
    // Explosive plays, defensive scores and comebacks keep the tails alive.
    expect(d.totalStdDev).toBeGreaterThan(9);
    expect(d.maxTotal - d.minTotal).toBeGreaterThan(30);
    expect(d.marginStdDev).toBeGreaterThan(10);
  });

  it("prices every market off the same 100 scores", async () => {
    const fair = await buildFairModel(game, odds);
    const projection = simulateGame(game, fair);

    expect(projection.spreadOutcomes("home", -3)).toHaveLength(100);
    expect(projection.totalOutcomes("Over", 45.5)).toHaveLength(100);
    expect(projection.totalOutcomes("Under", 49.5)).toHaveLength(100);
    expect(projection.moneylineOutcomes("away")).toHaveLength(100);

    // An alternate is settled on the same scores as its standard line.
    const standard = projection.spreadOutcomes("away", 3)!.filter(Boolean).length;
    const alternate = projection.spreadOutcomes("away", 7)!.filter(Boolean).length;
    expect(alternate).toBeGreaterThanOrEqual(standard);
  });
});
