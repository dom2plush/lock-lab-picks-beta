import { describe, expect, it } from "vitest";

import { alternateSpreadRule } from "../market-math.server";

describe("alternate spread direction and price rule", () => {
  it("accepts a bought point across a key number at negative odds", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: -110 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: -3.5, point: -2.5, price: -150 }).ok).toBe(true);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 2.5, point: 3.5, price: -199 }).ok).toBe(true);
  });

  it("rejects moving away from the key number", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7, point: 5.5, price: 122 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 7, point: 5.5, price: -110 }).ok).toBe(false);
  });

  it("rejects a bought point that crosses no key number", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 4.5, point: 5.5, price: -120 }).ok).toBe(false);
  });

  it("rejects plus-money and prices past -199", () => {
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: 105 }).ok).toBe(false);
    expect(alternateSpreadRule({ sport: "NFL", standardPoint: 6.5, point: 7.5, price: -200 }).ok).toBe(false);
  });
});
