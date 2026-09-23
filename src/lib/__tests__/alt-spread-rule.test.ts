import { describe, expect, it } from "vitest";

import { alternateSpreadRule } from "../market-math.server";

describe("alternate spread direction and price rule", () => {
  it("accepts a bought point across a key number at negative odds", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: -110 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7, point: 7.5, price: -130 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: -3.5, point: -2.5, price: -150 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 2.5, point: 3.5, price: -180 }).ok).toBe(true);
  });

  it("rejects moving away from the key number", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7, point: 5.5, price: 122 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7, point: 5.5, price: -110 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7.5, point: 7, price: -130 }).ok).toBe(false);
  });

  it("rejects a bought point that crosses no key number", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 4.5, point: 5.5, price: -120 }).ok).toBe(false);
  });

  it("rejects prices past -180 and plus money that is not sharp enough", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: -185 }).ok).toBe(false);
    expect(
      alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: 105, altHits: 30, runs: 50 }).ok,
    ).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: 105 }).ok).toBe(false);
    expect(
      alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: 250, altHits: 45, runs: 50 }).ok,
    ).toBe(false);
  });

  it("accepts plus money only when the sims cash it 35 of 50 or better", () => {
    expect(
      alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: 105, altHits: 35, runs: 50 }).ok,
    ).toBe(true);
    expect(
      alternateSpreadRule({ sport: "NFL", standardPoint: 2.5, point: 3.5, price: 150, altHits: 40, runs: 50 }).ok,
    ).toBe(true);
  });

  it("covers the full football key margin ladder up to 70", () => {
    for (const [std, alt] of [
      [13.5, 14.5],
      [-14.5, -13.5],
      [16.5, 17.5],
      [20.5, 21.5],
      [-21.5, -20.5],
      [69.5, 70.5],
    ] as const) {
      expect(alternateSpreadRule({ sport: "NFL", standardPoint: std, point: alt, price: -120 }).ok).toBe(true);
    }
  });
});
