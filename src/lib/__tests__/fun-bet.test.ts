/**
 * Fun bets: one primary TD fun bet whenever a verified TD market is posted,
 * plus an optional Bonus fun bet for a +200 or longer moneyline the model
 * clearly likes. The TD bet is never replaced, and +200+ never reaches Top 2.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runLockLabFormula } from "../analysis-engine.server";
import type { GameOdds, GameRow, MarketOffer } from "../lock-lab-types";

const capturedAt = "2026-09-20T15:00:00.000Z";

function makeGame(odds: GameOdds) {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    sport: "NFL",
    provider_game_id: "evt-fun",
    home_team: "Los Angeles Rams",
    away_team: "New York Giants",
    home_team_short: "RAMS",
    away_team_short: "GIANTS",
    commence_time: "2026-09-20T17:00:00.000Z",
    status: "scheduled",
    home_score: null,
    away_score: null,
    odds,
    injuries: [],
    is_demo: false,
  } satisfies GameRow;
}

const baseOdds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt,
  spread: { home: -3, away: 3, homePrice: -110, awayPrice: -110 },
  total: { points: 47.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -160, away: 140 },
};

function prop(market: string, player: string, selection: string, point: number | null, price: number, book = "FanDuel"): MarketOffer {
  return {
    market,
    selection,
    player,
    point,
    price,
    book,
    bookKey: book.toLowerCase(),
    capturedAt,
    eventId: "evt-fun",
  };
}

const TD_MARKETS = new Set(["First TD scorer", "Anytime TD", "Player TDs"]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fun bets", () => {
  it("keeps a TD fun bet and adds a +200+ moneyline only as a bonus", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    // Giants +3 on the spread but +400 on the moneyline: a long price the
    // simulated games clearly beat.
    const odds: GameOdds = { ...baseOdds, moneyline: { home: -500, away: 400 } };
    const props = [
      prop("player_anytime_td", "Kyren Williams", "Yes", null, -140),
      prop("player_1st_td", "Kyren Williams", "Yes", null, 650),
    ];
    const result = await runLockLabFormula(makeGame(odds), odds, { alternates: [], props });

    expect(TD_MARKETS.has(result.funBets[0]!.market)).toBe(true);
    expect(result.funBets[0]!.market).toBe("First TD scorer");
    const bonus = result.funBets[1];
    expect(bonus).toBeDefined();
    expect(bonus!.odds).toBe("+400");
    expect(bonus!.reason).toMatch(/Bonus fun bet/);
    expect(result.funBets.length).toBe(2);
    // +200 or longer never reaches the Top 2.
    for (const pick of result.topBets) {
      const price = Number(String(pick.odds ?? "0").replace("+", ""));
      expect(price).toBeLessThanOrEqual(199);
    }
  });

  it("does not force a bonus moneyline without meaningful edge", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const props = [prop("player_anytime_td", "Kyren Williams", "Yes", null, -140)];
    const result = await runLockLabFormula(makeGame(baseOdds), baseOdds, { alternates: [], props });
    expect(result.funBets.length).toBe(1);
    expect(result.funBets[0]!.market).toBe("Anytime TD");
  });

  it("uses a posted 2+ TD rung from another sportsbook when no scorer market exists", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const props = [
      prop("player_tds_over", "Kyren Williams", "Over", 0.5, -140, "BetMGM"),
      prop("player_tds_over", "Kyren Williams", "Over", 1.5, 450, "BetMGM"),
    ];
    const result = await runLockLabFormula(makeGame(baseOdds), baseOdds, { alternates: [], props });
    expect(result.funBets.length).toBe(1);
    expect(result.funBets[0]!.market).toBe("Player TDs");
    expect(result.funBets[0]!.label).toContain("Over 1.5");
    expect(result.funBets[0]!.odds).toBe("+450");
    // TD rungs stay out of the player props.
    expect(result.playerProps.some((p) => p.market === "Player TDs")).toBe(false);
  });

  it("shows no TD fun bet when no TD market is posted", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const result = await runLockLabFormula(makeGame(baseOdds), baseOdds, { alternates: [], props: [] });
    expect(result.funBets.every((f) => !TD_MARKETS.has(f.market))).toBe(true);
  });
});
