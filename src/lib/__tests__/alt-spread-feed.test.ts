import { describe, expect, it } from "vitest";
import { buildCandidates } from "../analysis-engine.server";
import type { GameRow, MarketOffer } from "../lock-lab-types";

// Falcons at Packers alternate spread ladder exactly as FanDuel posted it in the
// stored sportsbook feed (standard: ATL +7 -115 / GB -7 -105).
const FEED: Array<[number, number]> = [
  [-21.5, 3500], [-19.5, 3500], [-18.5, 3000], [-17.5, 2500], [-16.5, 1800], [-15.5, 1700],
  [-14.5, 1700], [-13.5, 1500], [-12.5, 1400], [-11.5, 1300], [-10.5, 1200], [-9.5, 1060],
  [-8.5, 1000], [-7.5, 870], [-6.5, 680], [-5.5, 560], [-4.5, 520], [-3.5, 450], [-2.5, 340],
  [-1.5, 300], [1.5, 240], [2.5, 215], [3.5, 154], [4.5, 134], [5.5, 122], [6.5, 100],
  [7.5, -130], [8.5, -156], [9.5, -162], [10.5, -188],
];
const offers: MarketOffer[] = FEED.map(([point, price]) => ({
  market: "alternate_spreads",
  selection: "Atlanta Falcons",
  point,
  price,
  book: "FanDuel",
  bookKey: "fanduel",
  capturedAt: "2026-09-23T03:00:00Z",
  eventId: "evt",
  isAlternate: true,
}));

// 50 simulated Falcons margins (negative = Falcons lose by that much).
const margins = [
  ...Array(8).fill(-7), ...Array(6).fill(-3), ...Array(6).fill(-10), ...Array(10).fill(-14),
  ...Array(10).fill(4), ...Array(5).fill(-1), ...Array(5).fill(-17),
];
const spreadOutcomes = (team: "home" | "away", point: number) =>
  margins.map((m) => (team === "away" ? m : -m) + point > 0);
const projection = {
  spreadOutcomes,
  spreadProb: (team: "home" | "away", point: number) =>
    spreadOutcomes(team, point).filter(Boolean).length / margins.length,
  totalOutcomes: () => null,
  totalProb: () => null,
  moneylineProb: () => null,
  moneylineOutcomes: () => null,
} as never;

const odds = {
  bookmaker: "FanDuel",
  bookmakerKey: "fanduel",
  capturedAt: "2026-09-23T03:00:00Z",
  spread: { home: -7, homePrice: -105, away: 7, awayPrice: -115 },
} as never;
const game = {
  sport: "NFL",
  home_team: "Green Bay Packers",
  away_team: "Atlanta Falcons",
  provider_game_id: "evt",
  odds,
} as unknown as GameRow;

describe("alternate spreads from the sportsbook feed", () => {
  const candidates = buildCandidates(game, odds, { alternates: offers, props: [] }, projection, {} as never);
  const alts = candidates.filter((c) => c.group === "alt" && c.selection === "Atlanta Falcons");

  it("grades Falcons +7.5 at its posted FanDuel price next to the +7 standard", () => {
    const rung = alts.find((c) => c.point === 7.5);
    expect(rung).toBeDefined();
    expect(rung!.price).toBe(-130);
    expect(rung!.book).toBe("FanDuel");
    expect(rung!.standardKey).toBe("spread-away");
    expect(rung!.alt?.keyGate?.ok).toBe(true);
    console.log("Falcons +7.5 evaluated:", rung!.label, "|", rung!.alt?.keyGate?.why);
  });

  it("keeps every rung within 3 points of the standard, even on a long ladder", () => {
    for (const p of [4.5, 5.5, 6.5, 7.5, 8.5, 9.5]) expect(alts.some((c) => c.point === p)).toBe(true);
  });

  it("never lets less protection or plus money pass the gate", () => {
    for (const p of [4.5, 5.5, 6.5]) expect(alts.find((c) => c.point === p)!.alt?.keyGate?.ok).toBe(false);
  });
});
