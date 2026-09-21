import { describe, expect, it } from "vitest";
import { limitPropBumps } from "../analysis-engine.server";
import type { MarketOffer } from "../lock-lab-types";

const offer = (market: string, player: string, point: number | null): MarketOffer => ({
  market,
  selection: "Over",
  player,
  point,
  price: -110,
  book: "DraftKings",
  bookKey: "draftkings",
  capturedAt: "2026-09-21T00:00:00.000Z",
});

describe("alternate prop bump limits", () => {
  it("keeps passing rungs within 25 yards and drops larger bumps", () => {
    const kept = limitPropBumps([
      offer("player_pass_yds", "QB", 250),
      offer("player_pass_yds", "QB", 225),
      offer("player_pass_yds", "QB", 275),
      offer("player_pass_yds", "QB", 180),
      offer("player_pass_yds", "QB", 330),
    ]).map((o) => o.point);
    expect(kept).toEqual([250, 225, 275]);
  });

  it("limits receptions to one and rushing yards to ten", () => {
    const kept = limitPropBumps([
      offer("player_receptions", "WR", 4.5),
      offer("player_receptions", "WR", 6.5),
      offer("player_rush_yds", "RB", 60),
      offer("player_rush_yds", "RB", 85),
    ]).map((o) => o.point);
    expect(kept).toEqual([4.5, 60]);
  });

  it("passes touchdown markets through untouched", () => {
    const tds = [offer("player_anytime_td", "WR", null), offer("player_1st_td", "WR", null)];
    expect(limitPropBumps(tds)).toHaveLength(2);
  });
});
