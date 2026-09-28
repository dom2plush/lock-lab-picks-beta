import { describe, expect, it } from "vitest";

import { publicSideSignal, sportsbookSideSignal } from "../analysis-engine.server";
import { hasPublicBetting } from "../lock-lab-types";

describe("manual public betting inputs", () => {
  it("ignores blank inputs entirely", () => {
    expect(hasPublicBetting(null)).toBe(false);
    expect(hasPublicBetting({})).toBe(false);
    expect(publicSideSignal("spread-home", {})).toBeNull();
    expect(publicSideSignal("spread-home", null)).toBeNull();
  });

  it("reads heavy public backing as the book-unfavourable side", () => {
    const heavyHome = { spreadBetPct: 80, spreadMoneyPct: 80 };
    const home = publicSideSignal("spread-home", heavyHome)!;
    const away = publicSideSignal("spread-away", heavyHome)!;
    expect(home).toBeLessThan(0);
    expect(away).toBeGreaterThan(0);
    expect(home).toBeCloseTo(-away, 6);
  });

  it("uses the over share for totals and leaves other markets untouched", () => {
    expect(publicSideSignal("total-over", { totalBetPct: 70 })!).toBeLessThan(0);
    expect(publicSideSignal("total-under", { totalBetPct: 70 })!).toBeGreaterThan(0);
    expect(publicSideSignal("prop-anything", { totalBetPct: 70 })).toBeNull();
  });

  it("still works without an odds snapshot and blends with the odds read", () => {
    const c = { key: "ml-away", standardKey: null, group: "standard" } as never;
    expect(sportsbookSideSignal(c, null, null, { mlBetPct: 90 })).toBeGreaterThan(0);
    expect(sportsbookSideSignal(c, null, null, null)).toBe(0);
  });
});
