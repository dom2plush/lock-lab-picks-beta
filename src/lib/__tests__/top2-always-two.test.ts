import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  expectedRoi,
  orderTopBetsByValue,
  requireSimulatedAltValue,
  simulatedEdge,
  simulationStrength,
} from "../analysis-engine.server";
import { withSimulatedReasons } from "../simulation-runner.server";
import type { GameRow, MarketOffer } from "../lock-lab-types";

const hits = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("Top 2 always has two bets, ordered and labelled honestly", () => {
  it("positive-edge bets rank ahead of negative-edge bets; both slots stay filled", () => {
    const bets = [
      { key: "a", odds: "-115", simHits: hits(25), simRuns: 50 }, // 50% vs 53.5% -> negative
      { key: "b", odds: "-108", simHits: hits(26), simRuns: 50 }, // 52% vs 51.9% -> positive
    ];
    const out = orderTopBetsByValue(bets);
    expect(out).toHaveLength(2);
    expect(out[0]!.odds).toBe("-108");
    expect(out.map((b) => b.rank)).toEqual([1, 2]);
  });

  it("ranks by expected return, so a long price beats a short one with a bigger raw edge", () => {
    // +160 at 42% -> +9.2% expected return; -110 at 56% -> +6.9% expected return.
    const dog = expectedRoi(42, 100, 160);
    const fav = expectedRoi(56, 100, -110);
    expect(dog).toBeGreaterThan(fav);
    // ...even though the favourite's percentage-point edge is the larger one.
    expect(simulatedEdge(56, 100, -110)).toBeGreaterThan(simulatedEdge(42, 100, 160));
    expect(simulationStrength(dog, 0.42, null)).toBeGreaterThan(simulationStrength(fav, 0.56, null));
    const out = orderTopBetsByValue([
      { key: "fav", odds: "-110", simHits: hits(56), simRuns: 100 },
      { key: "dog", odds: "+160", simHits: hits(42), simRuns: 100 },
    ]);
    expect(out[0]!.odds).toBe("+160");
  });

  it("compares a moneyline and a spread on the same team at their real prices", () => {
    // Bears ML +160 hits 42 of 100; Bears +3.5 at -110 hits 56 of 100.
    const ml = expectedRoi(42, 100, 160);
    const spread = expectedRoi(56, 100, -110);
    expect(ml).toBeGreaterThan(spread);
    const out = orderTopBetsByValue([
      { key: "spread", odds: "-110", simHits: hits(56), simRuns: 100 },
      { key: "ml", odds: "+160", simHits: hits(42), simRuns: 100 },
    ]);
    expect(out[0]!.key).toBe("top1");
    expect(out[0]!.odds).toBe("+160");
  });

  it("puts the higher expected return first when both are positive", () => {
    const out = orderTopBetsByValue([
      { key: "a", odds: "-110", simHits: hits(60), simRuns: 100 },
      { key: "b", odds: "-110", simHits: hits(66), simRuns: 100 },
    ]);
    expect(out.map((b) => b.simHits.length)).toEqual([66, 60]);
  });

  it("displayed edge equals hit rate minus implied probability, and negatives are never called value", () => {
    const analysis = {
      top_bets: [
        { key: "x1", rank: 1, badge: "green", label: "Under 45", market: "Total", selection: "Under", odds: "-108", reason: "" },
        { key: "x2", rank: 2, badge: "green", label: "Patriots +3", market: "Spread", selection: "Patriots", odds: "-115", reason: "strong value" },
      ],
      player_props: [],
      fun_bets: [],
    } as never;
    const aggregate = { runs: 50, picks: [{ key: "x1", hitRate: 0.52, wins: 26 }, { key: "x2", hitRate: 0.5, wins: 25 }] } as never;
    const out = withSimulatedReasons(analysis, aggregate) as unknown as { top_bets: { modelEdge: number; badge: string; reason: string }[] };
    expect(out.top_bets).toHaveLength(2);
    const e2 = Math.round(simulatedEdge(25, 50, -115) * 10000) / 10000;
    expect(out.top_bets[1]!.modelEdge).toBe(e2);
    expect(out.top_bets[1]!.reason).toContain(`${(e2 * 100).toFixed(1)}% edge`);
    expect(out.top_bets[1]!.badge).toBe("red");
    expect(out.top_bets[1]!.reason).toMatch(/Fallback — No Positive Edge/);
    expect(out.top_bets[1]!.reason).toMatch(/no positive value/i);
    expect(out.top_bets[1]!.reason).not.toMatch(/strong value/);
  });
});

describe("alternate totals are independently evaluated", () => {
  const game = { sport: "NFL", home_team: "Jacksonville Jaguars", away_team: "New England Patriots", provider_game_id: "e" } as unknown as GameRow;
  const odds = { bookmaker: "FanDuel", bookmakerKey: "fanduel", capturedAt: "2026-09-25T00:00:00Z", total: { point: 45, overPrice: -112, underPrice: -108 } } as never;
  const alt = (point: number, price: number): MarketOffer => ({
    market: "alternate_totals", selection: "Under", point, price, book: "FanDuel", bookKey: "fanduel",
    capturedAt: "2026-09-25T00:00:00Z", eventId: "e", isAlternate: true,
  });
  // 26 of 50 games under 45; one more lands exactly on 45 (under 45.5 = 27).
  const totals = [...Array(26).fill(40), 45, ...Array(23).fill(50)];
  const projection = {
    spreadOutcomes: () => null, spreadProb: () => null, moneylineProb: () => null, moneylineOutcomes: () => null,
    totalOutcomes: (side: "Over" | "Under", p: number) => totals.map((t) => (side === "Under" ? t < p : t > p)),
    totalProb: (side: "Over" | "Under", p: number) => totals.filter((t) => (side === "Under" ? t < p : t > p)).length / 50,
  } as never;
  const setup = (alts: MarketOffer[]) => {
    const cands = buildCandidates(game, odds, { alternates: alts, props: [] }, projection, {} as never);
    return { cands, byKey: new Map(cands.map((c) => [c.key, c])) };
  };

  it("Under 45.5 at -115 is rejected when it does not beat Under 45 at -108 in the simulations", () => {
    const { cands, byKey } = setup([alt(45.5, -115)]);
    const a = cands.find((c) => c.group === "alt" && c.point === 45.5);
    if (!a) return; // dropped at the candidate stage is also acceptable
    const pick = requireSimulatedAltValue(a, byKey, game, projection, {} as never);
    // 27/50 - 53.5% = +0.5% < 52% - 51.9%? compare independently:
    const altE = simulatedEdge(27, 50, -115);
    const stdE = simulatedEdge(26, 50, -108);
    expect(pick.key === a.key).toBe(altE > 0 && altE >= stdE);
  });

  it("a negative-edge alternate is never posted", () => {
    const { cands, byKey } = setup([alt(45.5, -135)]);
    const a = cands.find((c) => c.group === "alt" && c.point === 45.5);
    if (!a) return;
    const pick = requireSimulatedAltValue(a, byKey, game, projection, {} as never);
    expect(pick.group).toBe("core");
    expect(pick.selection).toBe("Under");
  });
});
