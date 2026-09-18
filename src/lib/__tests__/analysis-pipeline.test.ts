import { afterEach, describe, expect, it, vi } from "vitest";

import { runLockLabFormula } from "../analysis-engine.server";
import type { GameOdds, GameRow, MarketOffer } from "../lock-lab-types";
import { fetchEventMarkets } from "../odds-provider.server";

const capturedAt = "2026-09-20T15:00:00.000Z";
const odds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt,
  spread: { home: -2.5, away: 2.5, homePrice: -110, awayPrice: -110 },
  total: { points: 44.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -145, away: 125 },
};
const game = {
  id: "00000000-0000-4000-8000-000000000001",
  sport: "NFL",
  provider_game_id: "evt-broncos-chiefs",
  home_team: "Kansas City Chiefs",
  away_team: "Denver Broncos",
  home_team_short: "CHIEFS",
  away_team_short: "BRONCOS",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds,
  injuries: [],
  is_demo: false,
} satisfies GameRow;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("analysis pipeline fallbacks", () => {
  it("uses a measurable posted alternate when the full handicap read is unavailable", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const alternate: MarketOffer = {
      market: "alternate_spreads",
      selection: "Denver Broncos",
      point: 3.5,
      price: -110,
      book: "DraftKings",
      bookKey: "draftkings",
      capturedAt,
      eventId: game.provider_game_id,
      isAlternate: true,
    };

    const result = await runLockLabFormula(game, odds, { alternates: [alternate], props: [] });

    expect(result.topBets).toHaveLength(2);
    expect(result.topBets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "BRONCOS +3.5 (-110)",
          point: 3.5,
          price: -110,
          book: "DraftKings",
          capturedAt,
          standardPoint: 2.5,
          standardPrice: -110,
        }),
      ]),
    );
    expect(result.topBets.every((pick) => pick.price != null && pick.book && pick.capturedAt)).toBe(true);
    expect(result.notes.verdict).toBeNull();
  });

  it("returns only the requested result groups from the handicap response", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    const payload = {
      top: [],
      funBets: [],
      props: [],
      verdict: "No measurable edge.",
    };
    const stream = `data: ${JSON.stringify({ type: "response.completed", response: { output_text: JSON.stringify(payload) } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const result = await runLockLabFormula(game, odds);

    expect(result).not.toHaveProperty("badBet");
    expect(result.funBets).toEqual([]);
    expect(result.playerProps).toEqual([]);
  });
});

describe("alternate market retrieval", () => {
  it("keeps a returned spread ladder when another derivative query fails", async () => {
    vi.stubEnv("ODDS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        const markets = url.searchParams.get("markets") ?? "";
        if (markets === "alternate_spreads") {
          return Response.json({
            id: game.provider_game_id,
            commence_time: game.commence_time,
            home_team: game.home_team,
            away_team: game.away_team,
            bookmakers: [
              {
                key: "draftkings",
                title: "DraftKings",
                last_update: capturedAt,
                markets: [
                  {
                    key: "alternate_spreads",
                    last_update: capturedAt,
                    outcomes: [
                      { name: game.away_team, point: 3.5, price: -110 },
                      { name: game.home_team, point: -3.5, price: -110 },
                    ],
                  },
                ],
              },
            ],
          });
        }
        return new Response("market unavailable", { status: 422 });
      }),
    );

    const result = await fetchEventMarkets("NFL", game.provider_game_id);

    expect(result.alternates).toHaveLength(2);
    expect(result.alternates.every((offer) => offer.market === "alternate_spreads")).toBe(true);
    expect(result.coverage.received["alternate_spreads"]).toBe(2);
    expect(result.coverage.missing).toContain("alternate_totals");
  });
});