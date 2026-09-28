/** The TD Scorers section is the only fun-bet output. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runLockLabFormula } from "../analysis-engine.server";
import type { GameOdds, GameRow, MarketOffer } from "../lock-lab-types";
import { isTouchdownPick } from "../lock-lab-types";

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
  injuries: [
    { team: "Los Angeles Rams", player: "Kyren Williams", status: "active" },
    { team: "Los Angeles Rams", player: "Puka Nacua", status: "active" },
    { team: "New York Giants", player: "Malik Nabers", status: "active" },
    { team: "New York Giants", player: "Tyrone Tracy", status: "active" },
  ],
  is_demo: false,
} satisfies GameRow;

function prop(market: string, player: string, price: number): MarketOffer {
  return {
    market,
    selection: "Yes",
    player,
    point: null,
    price,
    book: "FanDuel",
    bookKey: "fanduel",
    capturedAt,
    eventId: game.provider_game_id,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("TD Scorers replaces Fun Bet", () => {
  it("returns no separate Fun Bet and keeps one Anytime plus one First TD per team", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const props = [
      prop("player_anytime_td", "Kyren Williams", -115),
      prop("player_anytime_td", "Puka Nacua", 165),
      prop("player_anytime_td", "Malik Nabers", 145),
      prop("player_anytime_td", "Tyrone Tracy", 185),
      prop("player_1st_td", "Kyren Williams", 500),
      prop("player_1st_td", "Puka Nacua", 850),
      prop("player_1st_td", "Malik Nabers", 750),
      prop("player_1st_td", "Tyrone Tracy", 900),
    ];
    const result = await runLockLabFormula(game, odds, { alternates: [], props });
    const touchdowns = result.playerProps.filter(isTouchdownPick);

    expect(result.funBets).toEqual([]);
    expect(touchdowns).toHaveLength(4);
    for (const team of [game.home_team, game.away_team]) {
      const teamPicks = touchdowns.filter((pick) => pick.team === team);
      expect(teamPicks.map((pick) => pick.market).sort()).toEqual(["Anytime TD", "First TD scorer"]);
    }
    expect(touchdowns.every((pick) => pick.simRuns === 100)).toBe(true);
    expect(touchdowns.every((pick) => (pick.simHitRate ?? 1) < 0.8)).toBe(true);
  });

  it("does not create a separate longshot moneyline Fun Bet", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const longshotOdds = { ...odds, moneyline: { home: -500, away: 400 } };
    const result = await runLockLabFormula(
      { ...game, odds: longshotOdds },
      longshotOdds,
      { alternates: [], props: [] },
    );

    expect(result.funBets).toEqual([]);
    expect(result.topBets.every((pick) => Number(String(pick.odds).replace("+", "")) <= 199)).toBe(true);
  });
});