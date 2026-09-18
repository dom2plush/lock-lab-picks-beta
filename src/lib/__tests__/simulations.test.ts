import { describe, expect, it } from "vitest";

import type { GameRow } from "../lock-lab-types";
import type { EngineOutput } from "../analysis-engine.server";
import { simulateBoard, simulationFingerprint, SIMULATION_RUNS } from "../simulation.server";

const game = {
  id: "11111111-1111-4111-8111-111111111111",
  sport: "NFL",
  provider_game_id: "evt-1",
  home_team: "Kansas City Chiefs",
  away_team: "Denver Broncos",
  home_team_short: "Chiefs",
  away_team_short: "Broncos",
  commence_time: "2026-09-20T17:00:00Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds: {
    bookmaker: "DraftKings",
    bookmakerKey: "draftkings",
    capturedAt: "2026-09-18T12:00:00Z",
    spread: { home: -2.5, away: 2.5, homePrice: -110, awayPrice: -110 },
    total: { points: 44.5, overPrice: -110, underPrice: -110 },
    moneyline: { home: -140, away: 120 },
  },
  injuries: [],
  is_demo: false,
} as unknown as GameRow;

const output = {
  topBets: [
    {
      key: "top1",
      rank: 1,
      badge: "yellow",
      label: "Broncos +3.5",
      market: "Alternate spread",
      selection: "Denver Broncos",
      line: "+3.5",
      point: 3.5,
      price: -140,
      book: "DraftKings",
      capturedAt: "2026-09-18T12:00:00Z",
      odds: "-140",
      reason: "test",
    },
  ],
  funBets: [],
  playerProps: [],
  notes: { propsAvailable: false, altMarketsAvailable: true, verdict: null },
  candidateAudit: { entries: [] },
} as unknown as EngineOutput;

const extra = { alternates: [], props: [] };

describe("simulation batches", () => {
  it("runs 50 deterministic simulations and settles the published picks", () => {
    const fp = simulationFingerprint(game, game.odds, extra);
    const a = simulateBoard(game, game.odds, output, fp);
    const b = simulateBoard(game, game.odds, output, fp);

    expect(a.simulations).toHaveLength(SIMULATION_RUNS);
    // Same inputs = identical board for every user.
    expect(a.simulations).toEqual(b.simulations);
    expect(a.aggregate.runs).toBe(50);

    const pick = a.aggregate.selections[0]!;
    expect(pick.simulatedProb).not.toBeNull();
    expect(pick.wins + pick.losses + pick.pushes).toBe(50);
    // A +3.5 dog against a -2.5 market line must cash more than half the time.
    expect(pick.simulatedProb!).toBeGreaterThan(0.45);
  });

  it("changes the fingerprint only when a real input moves", () => {
    const base = simulationFingerprint(game, game.odds, extra);
    const sameOddsLaterPull = simulationFingerprint(
      game,
      { ...game.odds, capturedAt: "2026-09-18T18:00:00Z" },
      extra,
    );
    expect(sameOddsLaterPull).toBe(base);

    const moved = simulationFingerprint(
      game,
      { ...game.odds, spread: { home: -3.5, away: 3.5, homePrice: -110, awayPrice: -110 } },
      extra,
    );
    expect(moved).not.toBe(base);

    const injured = simulationFingerprint(
      { ...game, injuries: [{ team: "Denver Broncos", player: "QB1", status: "out" }] } as GameRow,
      game.odds,
      extra,
    );
    expect(injured).not.toBe(base);
  });

  it("records stored-formula hit rates for prop and fun selections", () => {
    const withProps = {
      ...output,
      funBets: [
        {
          key: "fun-1",
          badge: "yellow",
          label: "Player A Anytime TD (+175)",
          market: "Anytime TD",
          player: "Player A",
          price: 175,
          point: null,
          odds: "+175",
          book: "DraftKings",
          capturedAt: "2026-09-18T12:00:00Z",
          estimatedProbability: 0.4,
          reason: "For fun only — keep it to smaller units.",
        },
      ],
      playerProps: [
        {
          key: "prop-1",
          badge: "yellow",
          label: "Player B Over 68.5 (-110)",
          player: "Player B",
          market: "Rushing yards",
          price: -110,
          point: 68.5,
          odds: "-110",
          book: "DraftKings",
          capturedAt: "2026-09-18T12:00:00Z",
          estimatedProbability: 0.56,
          reason: "test",
        },
      ],
    } satisfies EngineOutput;

    const batch = simulateBoard(game, game.odds, withProps, "prop-hit-rate");
    const prop = batch.aggregate.selections.find((selection) => selection.key === "prop-1");
    const fun = batch.aggregate.selections.find((selection) => selection.key === "fun-1");

    expect(prop?.section).toBe("prop");
    expect(fun?.section).toBe("fun");
    expect(prop?.wins + prop?.losses).toBe(50);
    expect(fun?.wins + fun?.losses).toBe(50);
    expect(prop?.simulatedProb).not.toBeNull();
    expect(fun?.simulatedProb).not.toBeNull();
  });
});
