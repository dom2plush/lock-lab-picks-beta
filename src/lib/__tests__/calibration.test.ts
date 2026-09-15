import { describe, expect, it } from "vitest";
import { canLeadBoard, gradeValue, robustnessScore } from "../market-math.server";

const rob = (grade: ReturnType<typeof gradeValue>, group: "core" | "alt" | "prop", opts: { probGain?: number; keysCrossed?: number; hasOpposite?: boolean } = {}) =>
  robustnessScore({ grade, group, ...opts });

describe("selection calibration", () => {
  it("1. strong standard bet grades GREEN-eligible and can lead", () => {
    const g = gradeValue({ modelProb: 0.56, price: -110, group: "core", evidenceStrength: 0.7 });
    expect(g.tier).toBe("strong");
    expect(g.ev!).toBeGreaterThan(0);
    expect(canLeadBoard(g, rob(g, "core", { hasOpposite: true })).ok).toBe(true);
  });

  it("2. legitimate alternate line with a partial-band edge is playable (YELLOW), not rejected", () => {
    const g = gradeValue({ modelProb: 0.565, price: -120, group: "alt", distance: 1, evidenceStrength: 0.55 });
    expect(g.tier).toBe("playable");
    expect(g.qualifies).toBe(true);
  });

  it("3. a no-edge board stays RED", () => {
    const g = gradeValue({ modelProb: 0.523, price: -110, group: "core", evidenceStrength: 0.5 });
    expect(g.tier).toBe("insufficient");
    expect(g.qualifies).toBe(false);
  });

  it("4. a +220 alternate on thin evidence stays RED and cannot lead", () => {
    const g = gradeValue({ modelProb: 0.325, price: 220, group: "alt", distance: 4.5, evidenceStrength: 0.25 });
    expect(g.tier).toBe("insufficient");
    expect(canLeadBoard(g, rob(g, "alt", { probGain: -0.14 })).ok).toBe(false);
  });

  it("5. an alternate buying a key number reaches at least YELLOW", () => {
    const g = gradeValue({ modelProb: 0.625, price: -145, group: "alt", distance: 1, evidenceStrength: 0.6 });
    expect(g.qualifies).toBe(true);
    expect(rob(g, "alt", { probGain: 0.05, keysCrossed: 1 })).toBeGreaterThan(
      rob(g, "alt", { probGain: -0.05, keysCrossed: 0 }),
    );
  });
});
