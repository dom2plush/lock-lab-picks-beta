import { describe, expect, it } from "vitest";

import { keyNumberGate, spreadGateKeysBetween, totalKeysBetween } from "../market-math.server";

const base = { runs: 50, standardHits: 25 };

describe("key-number gate for bought points", () => {
  it("recognises the approved spread key moves", () => {
    expect(spreadGateKeysBetween(6.5, 7.5, "NFL")).toEqual([7]);
    expect(spreadGateKeysBetween(2.5, 3.5, "NFL")).toEqual([3]);
    expect(spreadGateKeysBetween(-7.5, -6.5, "NFL")).toEqual([7]);
    expect(spreadGateKeysBetween(-3.5, -2.5, "NFL")).toEqual([3]);
    expect(spreadGateKeysBetween(4.5, 5.5, "NFL")).toEqual([]);
  });

  it("rejects a spread buy that crosses no key number", () => {
    const gate = keyNumberGate({ ...base, market: "spread", sport: "NFL", side: "A", standardPoint: 4.5, point: 5.5, altHits: 30 });
    expect(gate.ok).toBe(false);
  });

  it("requires the simulated games to confirm the extra covers", () => {
    const weak = keyNumberGate({ ...base, market: "spread", sport: "NFL", side: "A", standardPoint: 2.5, point: 3.5, altHits: 26 });
    const real = keyNumberGate({ ...base, market: "spread", sport: "NFL", side: "A", standardPoint: 2.5, point: 3.5, altHits: 28 });
    expect(weak.ok).toBe(false);
    expect(real.ok).toBe(true);
    expect(real.simGain).toBe(3);
  });

  it("gates totals on sport-specific scoring thresholds", () => {
    expect(totalKeysBetween(48.5, 49.5, "NFL")).toEqual([]);
    expect(totalKeysBetween(40.5, 41.5, "NFL")).toEqual([41]);
    const dead = keyNumberGate({ ...base, market: "total", sport: "NFL", side: "Under", standardPoint: 48.5, point: 49.5, altHits: 30 });
    const key = keyNumberGate({ ...base, market: "total", sport: "NFL", side: "Over", standardPoint: 41.5, point: 40.5, altHits: 28 });
    expect(dead.ok).toBe(false);
    expect(key.ok).toBe(true);
  });

  it("leaves alternates that sell points untouched", () => {
    const sell = keyNumberGate({ ...base, market: "spread", sport: "NFL", side: "A", standardPoint: 4.5, point: 3.5, altHits: 20 });
    expect(sell).toEqual({ ok: true, keys: [], simGain: null, why: "" });
  });
});
