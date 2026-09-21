/**
 * Player props are settled inside the same 50 simulated games as the game
 * picks: every published prop carries 50 real outcomes, never a coin flip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runLockLabFormula } from "../analysis-engine.server";
import { buildFairModel } from "../fair-model.server";
import { simulateGame } from "../game-sim.server";
import type { GameOdds, GameRow, MarketOffer } from "../lock-lab-types";
import { simulatePlayers } from "../player-sim.server";

const capturedAt = "2026-09-20T15:00:00.000Z";
const odds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt,
  spread: { home: -3, away: 3, homePrice: -110, awayPrice: -110 },
  total: { points: 47.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -160, away: 140 },
};

const game = {
  id: "00000000-0000-4000-8000-000000000003",
  sport: "NFL",
  provider_game_id: "evt-props",
  home_team: "Los Angeles Rams",
  away_team: "New York Giants",
  home_team_short: "RAMS",
  away_team_short: "GIANTS",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds,
  injuries: [{ team: "New York Giants", player: "Jaxson Dart", status: "questionable" }],
  is_demo: false,
} satisfies GameRow;

function prop(
  market: string,
  player: string,
  selection: string,
  point: number | null,
  price: number,
): MarketOffer {
  return {
    market,
    selection,
    player,
    point,
    price,
    book: "DraftKings",
    bookKey: "draftkings",
    capturedAt,
    eventId: game.provider_game_id,
  };
}

const props = [
  prop("player_pass_yds", "Jaxson Dart", "Over", 225.5, -115),
  prop("player_pass_yds", "Jaxson Dart", "Under", 225.5, -105),
  prop("player_pass_tds", "Jaxson Dart", "Over", 1.5, 120),
  prop("player_pass_tds", "Jaxson Dart", "Under", 1.5, -150),
  prop("player_receptions", "Puka Nacua", "Over", 5.5, -120),
  prop("player_receptions", "Puka Nacua", "Under", 5.5, -100),
  prop("player_reception_yds", "Puka Nacua", "Over", 72.5, -115),
  prop("player_anytime_td", "Kyren Williams", "Yes", null, -140),
  prop("player_1st_td", "Kyren Williams", "Yes", null, 650),
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("player props come out of the 50 simulated games", () => {
  it("produces exactly 50 outcomes per prop, consistent with the score model", async () => {
    const fair = await buildFairModel(game, odds);
    const projection = simulateGame(game, fair);
    const players = simulatePlayers(game, projection, props);

    expect(players.runs).toBe(50);
    const over = players.outcomes({
      market: "player_pass_yds",
      player: "Jaxson Dart",
      selection: "Over",
      point: 225.5,
    });
    const under = players.outcomes({
      market: "player_pass_yds",
      player: "Jaxson Dart",
      selection: "Under",
      point: 225.5,
    });
    expect(over).toHaveLength(50);
    expect(under).toHaveLength(50);
    // Same simulated stat line: a player cannot go over and under in one game.
    over!.forEach((won, index) => expect(won).toBe(!under![index]));

    // More yards is never easier to clear than fewer, inside the same runs.
    const easy = players.probability({
      market: "player_pass_yds",
      player: "Jaxson Dart",
      selection: "Over",
      point: 180.5,
    })!;
    const hard = players.probability({
      market: "player_pass_yds",
      player: "Jaxson Dart",
      selection: "Over",
      point: 320.5,
    })!;
    expect(easy).toBeGreaterThanOrEqual(hard);

    // An unknown player is never invented: it falls back instead.
    expect(
      players.outcomes({
        market: "player_pass_yds",
        player: "Nobody At All",
        selection: "Over",
        point: 200.5,
      }),
    ).toBeNull();
  });

  it("publishes props settled against those same 50 runs", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const result = await runLockLabFormula(game, odds, { alternates: [], props });

    expect(result.playerProps.length).toBeGreaterThan(0);
    for (const pick of [...result.playerProps, ...result.funBets]) {
      expect(pick.simRuns).toBe(50);
      expect(Array.isArray(pick.simHits)).toBe(true);
      expect(pick.simHits!.every((run) => run >= 1 && run <= 50)).toBe(true);
    }
    for (const pick of result.topBets) {
      expect(pick.simRuns).toBe(50);
    }
  });
});
