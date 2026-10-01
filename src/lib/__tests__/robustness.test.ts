import { describe, expect, it } from "vitest";
import { impliedProbability, robustBadge, robustnessFromHits } from "../robustness";

const hits = (base: number, stress: number) => [
  ...Array.from({ length: base }, (_, i) => i + 1),
  ...Array.from({ length: stress }, (_, i) => 501 + i),
];

describe("base vs stress robustness", () => {
  it("converts American odds correctly", () => {
    expect(impliedProbability(-148)).toBeCloseTo(148 / 248, 10);
    expect(impliedProbability(160)).toBeCloseTo(100 / 260, 10);
  });

  it("splits 500 base and 500 stress runs and measures each", () => {
    const r = robustnessFromHits(hits(330, 305), 1000, -148)!;
    expect(r.baseRuns).toBe(500);
    expect(r.stressRuns).toBe(500);
    expect(r.baseHitRate).toBe(0.66);
    expect(r.stressHitRate).toBe(0.61);
    expect(r.combinedHitRate).toBe(0.635);
    expect(r.expectedRoi).toBeCloseTo(0.635 * (100 / 148) - 0.365, 3);
    expect(r.agreementLevel).toBe("MEDIUM");
    expect(robustBadge(r)).toBe("green");
  });

  it("does not let the combined number hide a stress collapse", () => {
    const r = robustnessFromHits(hits(360, 270), 1000, -148)!;
    expect(r.combinedEdge).toBeGreaterThan(0);
    expect(robustBadge(r)).toBe("red");
  });

  it("a slightly weaker stress result can still be green", () => {
    const r = robustnessFromHits(hits(300, 290), 1000, -110)!;
    expect(robustBadge(r)).toBe("green");
  });

  it("a huge edge needs strong corroboration", () => {
    const r = robustnessFromHits(hits(400, 370), 1000, 100)!;
    expect(r.combinedEdge).toBeGreaterThan(0.12);
    expect(robustBadge(r)).toBe("yellow");
  });
});
