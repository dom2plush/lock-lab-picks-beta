import { describe, expect, it } from "vitest";
import { canLeadBoard, gradeValue, riskAdjustedScore, robustnessScore } from "../market-math.server";

/**
 * Regression guard for the Titans case: TITANS +7 (-110) standard versus
 * TITANS +2.5 (+220) alternate. The alternate surrenders 4.5 points of
 * protection for a bigger payout. Even when its raw modelled EV looks higher,
 * it must not rank #1.
 */
const standard = gradeValue({ modelProb: 0.55, price: -110, group: "core", evidenceStrength: 0.65 });

const longAlternate = gradeValue({
  modelProb: 0.345, // barely above the 31.25% implied by +220
  price: 220,
  group: "alt",
  distance: 4.5,
  evidenceStrength: 0.3,
});

const standardRobustness = robustnessScore({ grade: standard, group: "core", hasOpposite: true });
const altRobustness = robustnessScore({
  grade: longAlternate,
  group: "alt",
  probGain: -0.14, // points sold, not bought
  keysCrossed: 0,
});

describe("+220 alternate cannot lead on raw EV", () => {
  it("has the higher raw EV of the two", () => {
    expect(longAlternate.ev!).toBeGreaterThan(standard.ev!);
  });

  it("is discounted below the standard line on risk-adjusted value", () => {
    expect(riskAdjustedScore(longAlternate, altRobustness)).toBeLessThan(
      riskAdjustedScore(standard, standardRobustness),
    );
  });

  it("is refused the #1 slot when its edge only partly clears the band", () => {
    expect(longAlternate.tier).not.toBe("strong");
    const lead = canLeadBoard(longAlternate, altRobustness);
    expect(lead.ok).toBe(false);
    expect(lead.why).toMatch(/uncertainty band/);
  });

  it("still allows the reliable standard line to lead", () => {
    expect(canLeadBoard(standard, standardRobustness).ok).toBe(true);
  });

  it("does not ban long prices outright: a big, well-supported edge can still lead", () => {
    const strongLongShot = gradeValue({
      modelProb: 0.52,
      price: 190,
      group: "core",
      evidenceStrength: 0.9,
    });
    expect(strongLongShot.tier).toBe("strong");
    expect(canLeadBoard(strongLongShot, robustnessScore({ grade: strongLongShot, group: "core", hasOpposite: true })).ok).toBe(true);
  });

  it("selling protection is penalised more than buying it", () => {
    const bought = robustnessScore({ grade: longAlternate, group: "alt", probGain: 0.08, keysCrossed: 1 });
    expect(altRobustness).toBeLessThan(bought);
  });
});
