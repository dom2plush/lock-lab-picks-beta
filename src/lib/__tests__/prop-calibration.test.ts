import { describe, expect, it } from "vitest";
import { robustBadge, robustnessFromHits, validatePropOpportunity } from "../robustness";

const hits = (base: number, stress: number) => [
  ...Array.from({ length: base }, (_, i) => i + 1),
  ...Array.from({ length: stress }, (_, i) => 501 + i),
];

describe("prop calibration", () => {
  it("validated +173 prop at 50% stays GREEN", () => {
    const r = robustnessFromHits(hits(252, 248), 1000, 173)!;
    const check = validatePropOpportunity(r, { projectedMedian: 62, baselineLine: 58, availability: 1, teamKnown: true, ladderCalibrated: true }, "Over", 58.5);
    expect(check.flagged && check.supported).toBe(true);
    expect(robustBadge(r, { opportunity: check })).toBe("green");
  });
  it("unconfirmed opportunity reduces to YELLOW, never deleted", () => {
    const r = robustnessFromHits(hits(252, 248), 1000, 173)!;
    const check = validatePropOpportunity(r, { projectedMedian: 50, baselineLine: 50, availability: 1, teamKnown: true, ladderCalibrated: false }, "Over", 58.5);
    expect(check.supported).toBe(false);
    expect(robustBadge(r, { opportunity: check })).toBe("yellow");
  });
  it("64% base / 61% stress at -110 can be GREEN", () => {
    expect(robustBadge(robustnessFromHits(hits(320, 305), 1000, -110))).toBe("green");
  });
  it("67% base / 58% stress is not rejected", () => {
    expect(robustBadge(robustnessFromHits(hits(335, 290), 1000, -110))).not.toBe("red");
  });
});
