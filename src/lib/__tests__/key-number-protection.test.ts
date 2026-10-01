import { describe, expect, it } from "vitest";
import { keyNumberChoice } from "../analysis-engine.server";

type Entry = Parameters<typeof keyNumberChoice>[0];

const line = (team: string, point: number, price: number, hitCount: number, roi: number): Entry =>
  ({
    c: { key: `${team}${point}`, market: "Spread", selection: team, point, price, label: `${team} ${point}` },
    hits: Array.from({ length: hitCount }, (_, i) => i + 1),
    runs: 1000,
    roi,
  }) as unknown as Entry;

describe("key-number spread protection", () => {
  it("bumps the Browns +2.5 underdog to +3.5 even when juice costs ROI", () => {
    const std = line("Browns", 2.5, 100, 539, 0.078);
    const alt = line("Browns", 3.5, -143, 569, -0.033);
    expect(keyNumberChoice(std, [std, alt])).toBe(alt);
  });

  it("bumps a -3.5 favorite to -2.5", () => {
    const std = line("Steelers", -3.5, -105, 470, 0.0);
    const alt = line("Steelers", -2.5, -135, 500, -0.03);
    expect(keyNumberChoice(std, [std, alt])).toBe(alt);
  });

  it.each([7, 10, 14, 21, 28])("protects across key number %i for dogs and favorites", (k) => {
    const dog = line("Dog", k - 0.5, -110, 500, 0.0);
    const dogAlt = line("Dog", k + 0.5, -150, 520, -0.05);
    expect(keyNumberChoice(dog, [dog, dogAlt])).toBe(dogAlt);
    const fav = line("Fav", -(k + 0.5), -110, 480, 0.0);
    const favAlt = line("Fav", -(k - 0.5), -150, 500, -0.05);
    expect(keyNumberChoice(fav, [fav, favAlt])).toBe(favAlt);
  });

  it("does not force a non-key move that isn't worth the price", () => {
    const std = line("Team", 4.5, -110, 500, 0.0);
    const alt = line("Team", 5.5, -150, 510, -0.05);
    expect(keyNumberChoice(std, [std, alt])).toBe(std);
  });
});
