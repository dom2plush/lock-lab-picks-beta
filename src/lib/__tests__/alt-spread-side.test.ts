import { describe, expect, it } from "vitest";

import { buildCandidates, enforceAltSpreadSide, preferKeyNumberSpread } from "../analysis-engine.server";
import type { GameRow, MarketOffer } from "../lock-lab-types";
import { alternateSpreadRule } from "../market-math.server";

const FALCONS = "Atlanta Falcons";
const PACKERS = "Green Bay Packers";

// Standard: ATL +6.5 -110 / GB -6.5 -110.
const odds = {
  bookmaker: "FanDuel",
  bookmakerKey: "fanduel",
  capturedAt: "2026-09-23T03:00:00Z",
  spread: { home: -6.5, homePrice: -110, away: 6.5, awayPrice: -110 },
} as never;
const game = {
  sport: "NFL",
  home_team: PACKERS,
  away_team: FALCONS,
  provider_game_id: "evt",
  odds,
} as unknown as GameRow;

const offer = (selection: string, point: number, price: number): MarketOffer => ({
  market: "alternate_spreads",
  selection,
  point,
  price,
  book: "FanDuel",
  bookKey: "fanduel",
  capturedAt: "2026-09-23T03:00:00Z",
  eventId: "evt",
  isAlternate: true,
});

// 50 simulated Falcons margins: several land exactly on a 7-point Packers win.
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

function board(alternates: MarketOffer[]) {
  const candidates = buildCandidates(game, odds, { alternates, props: [] }, projection, {} as never);
  // Every candidate carries a positive edge so only the side/number rules decide.
  for (const c of candidates) (c as { grade?: unknown }).grade = { modelProb: 0.6, edge: 0.05, ev: 0.05 };
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const falcons = candidates.find((c) => c.key === "spread-away")!;
  const packers = candidates.find((c) => c.key === "spread-home")!;
  return { candidates, byKey, falcons, packers };
}

const FEED = [
  offer(FALCONS, 7.5, -130),
  offer(FALCONS, 5.5, 120),
  offer(PACKERS, -7, -102),
  offer(PACKERS, -7.5, 110),
  offer(PACKERS, -5.5, -135),
];

describe("alternate spreads never switch sides", () => {
  it("Falcons +6.5 moves to the posted Falcons +7.5", () => {
    const { candidates, falcons } = board(FEED);
    expect(falcons.selection).toBe(FALCONS);
    expect(falcons.point).toBe(6.5);
    const pick = preferKeyNumberSpread(falcons, candidates);
    expect(pick.selection).toBe(FALCONS);
    expect(pick.point).toBe(7.5);
    expect(pick.price).toBe(-130);
    expect(pick.book).toBe("FanDuel");
  });

  it("without a posted Falcons +7.5, Falcons +6.5 stays Falcons +6.5 — never Packers -7", () => {
    const { candidates, falcons } = board(FEED.filter((o) => !(o.selection === FALCONS && o.point === 7.5)));
    const pick = preferKeyNumberSpread(falcons, candidates);
    expect(pick).toBe(falcons);
    expect(pick.selection).toBe(FALCONS);
    expect(pick.point).toBe(6.5);
  });

  it("Falcons +6.5 can never become Packers -7, even if a rung is mislabelled", () => {
    const { candidates, byKey, falcons } = board(FEED);
    // Tamper: a Packers -7 rung pointing at the Falcons standard line.
    const packersSeven = candidates.find((c) => c.group === "alt" && c.selection === PACKERS && c.point === -7)!;
    (packersSeven as { standardKey?: string }).standardKey = "spread-away";
    const pick = preferKeyNumberSpread(falcons, candidates);
    expect(pick.selection).toBe(FALCONS);
    expect(pick.point).toBe(7.5);
    // The final guard sends a violating rung back to its OWN team's standard line.
    const guarded = enforceAltSpreadSide(packersSeven, byKey);
    expect(guarded.selection).toBe(PACKERS);
    expect(guarded.key).toBe("spread-home");
  });

  it("Packers -6.5 only ever moves to more protection on the Packers side", () => {
    const { candidates, packers } = board(FEED);
    const pick = preferKeyNumberSpread(packers, candidates);
    expect(pick.selection).toBe(PACKERS);
    expect((pick.point ?? 0) >= -6.5).toBe(true);
  });

  it("no candidate chosen for either side ever lands on the other team", () => {
    const { candidates, byKey, falcons, packers } = board(FEED);
    for (const standard of [falcons, packers]) {
      const pick = enforceAltSpreadSide(preferKeyNumberSpread(standard, candidates), byKey);
      expect(pick.selection).toBe(standard.selection);
    }
  });

  it("less protection is always rejected (Falcons +6.5 -> Falcons -5.5 / +5.5)", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: -5.5, price: -110 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 5.5, price: -110 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: -7.5, point: -6.5, price: -130, altHits: 30, runs: 50 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: -3.5, point: -2.5, price: -140, altHits: 30, runs: 50 }).ok).toBe(true);
  });

  it("an alternate naming neither team is dropped from the board", () => {
    const { candidates } = board([...FEED, offer("Falcons", 7.5, -125)]);
    expect(candidates.some((c) => c.group === "alt" && c.selection === "Falcons")).toBe(false);
  });
});
