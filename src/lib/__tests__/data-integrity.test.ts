import { describe, expect, it } from "vitest";

import type { GameRow, MarketOffer } from "../lock-lab-types";
import { verifyAlternateOffers, verifyPropOffers } from "../prop-integrity";

const game = {
  id: "g1",
  sport: "NFL",
  provider_game_id: "evt-123",
  home_team: "Kansas City Chiefs",
  away_team: "Denver Broncos",
  home_team_short: "CHIEF",
  away_team_short: "BRONC",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds: { bookmaker: "DraftKings", bookmakerKey: "draftkings", capturedAt: "2026-09-20T15:00:00.000Z" },
  injuries: [],
  is_demo: false,
} as unknown as GameRow;

const base: MarketOffer = {
  market: "player_rush_yds",
  selection: "Over",
  player: "Bijan Robinson",
  point: 68.5,
  price: -115,
  book: "DraftKings",
  bookKey: "draftkings",
  capturedAt: "2026-09-20T15:00:00.000Z",
  eventId: "evt-123",
};

describe("player prop verification", () => {
  it("keeps a prop from this exact event and sportsbook", () => {
    const { verified, rejected } = verifyPropOffers([base], game);
    expect(verified).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects a prop belonging to another game", () => {
    const { verified, rejected } = verifyPropOffers([{ ...base, eventId: "evt-999" }], game);
    expect(verified).toHaveLength(0);
    expect(rejected[0]!.reason).toContain("different game");
  });

  it("rejects a prop priced at a different sportsbook than the displayed snapshot", () => {
    const { verified, rejected } = verifyPropOffers(
      [{ ...base, book: "FanDuel", bookKey: "fanduel" }],
      game,
    );
    expect(verified).toHaveLength(0);
    expect(rejected[0]!.reason).toContain("sportsbook differs");
  });

  it("rejects a prop with no player, no timestamp or an unsupported market", () => {
    const offers = [
      { ...base, player: undefined },
      { ...base, capturedAt: "" },
      { ...base, market: "player_made_up_market" },
    ] as MarketOffer[];
    const { verified, rejected } = verifyPropOffers(offers, game);
    expect(verified).toHaveLength(0);
    expect(rejected).toHaveLength(3);
  });

  it("drops duplicate offers for the same player, market and line", () => {
    const { verified } = verifyPropOffers([base, { ...base }], game);
    expect(verified).toHaveLength(1);
  });
});

describe("alternate line verification", () => {
  const alt: MarketOffer = {
    market: "alternate_spreads",
    selection: "Denver Broncos",
    point: 3.5,
    price: -145,
    book: "DraftKings",
    bookKey: "draftkings",
    capturedAt: "2026-09-20T15:00:00.000Z",
    eventId: "evt-123",
  };

  it("keeps an alternate line for a team actually in this game", () => {
    expect(verifyAlternateOffers([alt], game).verified).toHaveLength(1);
  });

  it("rejects an alternate line for a team not in this game", () => {
    const { verified, rejected } = verifyAlternateOffers(
      [{ ...alt, selection: "Buffalo Bills" }],
      game,
    );
    expect(verified).toHaveLength(0);
    expect(rejected[0]!.reason).toContain("does not match either team");
  });

  it("rejects an alternate line with no posted number", () => {
    expect(verifyAlternateOffers([{ ...alt, point: null }], game).verified).toHaveLength(0);
  });
});

describe("pregame gate", () => {
  // Same rule the server applies before generating any new pick.
  const isPregame = (g: Pick<GameRow, "commence_time" | "status">, now: number) =>
    g.status === "scheduled" && new Date(g.commence_time).getTime() > now;
  const kickoff = new Date(game.commence_time).getTime();

  it("allows new picks before kickoff", () => {
    expect(isPregame(game, kickoff - 60_000)).toBe(true);
  });

  it("locks picks once kickoff has passed", () => {
    expect(isPregame(game, kickoff + 1)).toBe(false);
  });

  it("locks picks for a live or final game regardless of clock", () => {
    expect(isPregame({ ...game, status: "live" }, kickoff - 60_000)).toBe(false);
    expect(isPregame({ ...game, status: "final" }, kickoff - 60_000)).toBe(false);
  });
});
