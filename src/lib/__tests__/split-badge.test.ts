import { describe, expect, it } from "vitest";
import { applySplitBadge } from "../simulation-runner.server";

const odds = { spread: { home: 3.5, away: -3.5, homePrice: -105, awayPrice: -115 } } as never;
const base = { badge: "red", reason: "r.", modelEdge: 0.002, sideKey: "spread-home" };

describe("split badge", () => {
  it("ignores missing splits and strong bets", () => {
    expect(applySplitBadge(base, { publicBetting: null, odds, previousOdds: null }).badge).toBe("red");
    expect(applySplitBadge({ ...base, badge: "green" }, { publicBetting: { spreadBetPct: 10, spreadMoneyPct: 10 }, odds, previousOdds: null }).badge).toBe("green");
  });
  it("needs heavy opposite action and simulation support", () => {
    // Mild opposite action (below the heavy threshold) stays red even when the
    // edge is only slightly negative — the share gate still applies.
    expect(applySplitBadge({ ...base, modelEdge: -0.02 }, { publicBetting: { spreadBetPct: 45, spreadMoneyPct: 45 }, odds, previousOdds: null }).badge).toBe("red");
    // A clearly negative edge (beyond the support tolerance) is never upgraded.
    expect(applySplitBadge({ ...base, modelEdge: -0.05 }, { publicBetting: { spreadBetPct: 20, spreadMoneyPct: 25 }, odds, previousOdds: null }).badge).toBe("red");
  });
  it("upgrades slightly negative edges when the public is heavily opposite", () => {
    const heavy = { spreadBetPct: 20, spreadMoneyPct: 25 };
    // A slightly negative edge (within the support tolerance) no longer blocks
    // the red → yellow upgrade; the sportsbook-favourable read then lifts it.
    expect(applySplitBadge({ ...base, modelEdge: -0.02 }, { publicBetting: heavy, odds, previousOdds: null }).badge).toBe("green");
    expect(applySplitBadge({ ...base, badge: "yellow", modelEdge: -0.02 }, { publicBetting: heavy, odds, previousOdds: null }).badge).toBe("green");
  });
  it("red to yellow, then green when book-favourable", () => {
    const heavy = { spreadBetPct: 20, spreadMoneyPct: 25 };
    // Heavy opposite public splits alone satisfy the combined book-favourable
    // read when no odds evidence is available — no single signal is required.
    expect(applySplitBadge(base, { publicBetting: heavy, odds: null, previousOdds: null }).badge).toBe("green");
    expect(applySplitBadge(base, { publicBetting: heavy, odds, previousOdds: null }).badge).toBe("green");
    // Mild opposite action (below the heavy threshold) still stops at red.
    expect(applySplitBadge(base, { publicBetting: { spreadBetPct: 40, spreadMoneyPct: 40 }, odds, previousOdds: null }).badge).toBe("red");
  });
  it("Bears +3.5: thin edge, heavy opposite splits, favourable book read → green", () => {
    // 52% simulated vs ~52.4% implied at -110: model edge -0.0038 (thin, no EV gate).
    // 29/29 home splits ⇒ 71% opposite public share; the odds fixture reads
    // book-favourable for the home side.
    const bears = {
      badge: "red",
      reason: "r.",
      modelEdge: -0.0038,
      sideKey: "spread-home",
      odds: "-110",
    };
    const splits = { spreadBetPct: 29, spreadMoneyPct: 29 };
    expect(applySplitBadge(bears, { publicBetting: splits, odds, previousOdds: null }).badge).toBe("green");
  });
});

describe("final displayed Top 2 badge", () => {
  it("shows GREEN for the stored Bears +3.5 card even without a saved sideKey", async () => {
    const { withDisplayBadges } = await import("../simulation-runner.server");
    const card = {
      top_bets: [
        { key: "top1", badge: "red", label: "BEARS +3.5 (-110)", market: "Spread", selection: "Chicago Bears", odds: "-110", modelEdge: -0.0038, simHitRate: 0.52, reason: "r." },
      ],
    };
    const shown = withDisplayBadges(card, {
      home_team: "Chicago Bears",
      away_team: "Philadelphia Eagles",
      public_betting: { spreadBetPct: 23, spreadMoneyPct: 35, mlBetPct: 8, mlMoneyPct: 9 } as never,
      odds: odds,
    });
    expect((shown.top_bets as { badge: string }[])[0].badge).toBe("green");
  });
});
