import { describe, expect, it } from "vitest";
import { canLeadBoard, gradeValue, robustnessScore } from "../market-math.server";

const lead = (
  grade: ReturnType<typeof gradeValue>,
  group: "core" | "alt" | "prop",
  opts: { probGain?: number; keysCrossed?: number; hasOpposite?: boolean } = {},
) => canLeadBoard(grade, robustnessScore({ grade, group, ...opts }));

describe("top 2 threshold: playable (yellow) bets are eligible to lead", () => {
  it("1. a strong GREEN standard bet can be #1", () => {
    const g = gradeValue({ modelProb: 0.58, price: -110, group: "core", evidenceStrength: 0.8 });
    expect(g.tier).toBe("strong");
    expect(lead(g, "core", { hasOpposite: true }).ok).toBe(true);
  });

  it("2. a legitimate YELLOW standard bet can be #1", () => {
    const g = gradeValue({ modelProb: 0.54, price: -110, group: "core", evidenceStrength: 0.6 });
    expect(g.tier).toBe("playable");
    expect(lead(g, "core", { hasOpposite: true }).ok).toBe(true);
  });

  it("3. the standard line can be passed while a sharper alternate is playable", () => {
    const standard = gradeValue({ modelProb: 0.505, price: -110, group: "core", evidenceStrength: 0.6 });
    const alternate = gradeValue({
      modelProb: 0.63,
      price: -145,
      group: "alt",
      distance: 1,
      evidenceStrength: 0.6,
    });
    expect(standard.tier).toBe("insufficient");
    expect(standard.qualifies).toBe(false);
    expect(alternate.tier).toBe("playable");
    expect(lead(alternate, "alt", { probGain: 0.05, keysCrossed: 1 }).ok).toBe(true);
  });

  it("4. a marginal no-edge bet stays RED", () => {
    const g = gradeValue({ modelProb: 0.53, price: -110, group: "core", evidenceStrength: 0.5 });
    expect(g.tier).toBe("insufficient");
    expect(g.qualifies).toBe(false);
    expect(lead(g, "core", { hasOpposite: true }).ok).toBe(false);
  });

  it("5. a +250 longshot on thin evidence cannot lead on payout alone", () => {
    const g = gradeValue({
      modelProb: 0.32,
      price: 250,
      group: "alt",
      distance: 4,
      evidenceStrength: 0.3,
    });
    expect(g.ev!).toBeGreaterThan(0);
    expect(g.tier).not.toBe("strong");
    const verdict = lead(g, "alt", { probGain: -0.12 });
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/long price/);
  });

  it("6. a long price with a near-full band edge and a robust estimate may still lead", () => {
    const g = gradeValue({ modelProb: 0.44, price: 190, group: "core", evidenceStrength: 0.9 });
    expect(g.qualifies).toBe(true);
    expect(lead(g, "core", { hasOpposite: true }).ok).toBe(true);
  });
});
