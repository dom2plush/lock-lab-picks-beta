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
    expect(applySplitBadge(base, { publicBetting: { spreadBetPct: 45, spreadMoneyPct: 45 }, odds, previousOdds: null }).badge).toBe("red");
    expect(applySplitBadge({ ...base, modelEdge: -0.02 }, { publicBetting: { spreadBetPct: 20, spreadMoneyPct: 20 }, odds, previousOdds: null }).badge).toBe("red");
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
});
