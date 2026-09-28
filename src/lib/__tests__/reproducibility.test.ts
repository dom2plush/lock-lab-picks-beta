/**
 * Reproducibility: the 100 simulated games for a matchup are seeded from the
 * game id plus the model version and nothing else, so the same inputs always
 * produce identical scores, player outcomes and probabilities for every user —
 * and the dataset those runs saw is frozen alongside them.
 */
import { describe, expect, it } from "vitest";

import { buildFairModel } from "../fair-model.server";
import { simulateGame } from "../game-sim.server";
import type { GameOdds, GameRow } from "../lock-lab-types";
import { simulatePlayers } from "../player-sim.server";
import {
  SIMULATION_ENGINE_VERSION,
  SIMULATION_RUNS,
  datasetSnapshot,
  inputSnapshot,
  meaningfulInputChange,
  picksToSimulate,
  runSimulations,
  simulationSeedKey,
} from "../simulation.server";

const odds: GameOdds = {
  bookmaker: "DraftKings",
  bookmakerKey: "draftkings",
  capturedAt: "2026-09-20T15:00:00.000Z",
  spread: { home: -3, away: 3, homePrice: -110, awayPrice: -110 },
  total: { points: 45.5, overPrice: -110, underPrice: -110 },
  moneyline: { home: -155, away: 135 },
};

const game = {
  id: "00000000-0000-4000-8000-0000000000aa",
  sport: "NFL",
  provider_game_id: "evt-repro",
  home_team: "Seattle Seahawks",
  away_team: "Arizona Cardinals",
  home_team_short: "SEA",
  away_team_short: "ARI",
  commence_time: "2026-09-20T17:00:00.000Z",
  status: "scheduled",
  home_score: null,
  away_score: null,
  odds,
  injuries: [{ team: "Arizona Cardinals", player: "Trey McBride", status: "questionable" }],
  is_demo: false,
} satisfies GameRow;

describe("simulations are reproducible", () => {
  it("seeds only on the game and the model version", () => {
    expect(simulationSeedKey(game)).toBe(`${game.id}:${SIMULATION_ENGINE_VERSION}`);
    // A fresh odds pull (new capture time, same numbers) must not move the seed.
    const repulled = {
      ...game,
      odds: { ...odds, capturedAt: "2026-09-20T15:40:00.000Z" },
      odds_updated_at: "2026-09-20T15:40:00.000Z",
    } as GameRow;
    expect(simulationSeedKey(repulled)).toBe(simulationSeedKey(game));
  });

  it("produces byte-identical scores and player outcomes on repeat runs", async () => {
    const fairA = await buildFairModel(game, odds);
    const fairB = await buildFairModel(game, odds);
    const a = simulateGame(game, fairA);
    const b = simulateGame(game, fairB);

    expect(a.scores.length).toBe(SIMULATION_RUNS);
    expect(JSON.stringify(a.scores)).toBe(JSON.stringify(b.scores));

    const pa = simulatePlayers(game, a, []);
    const pb = simulatePlayers(game, b, []);
    expect(JSON.stringify(pa.players)).toBe(JSON.stringify(pb.players));
  });

  it("settles the same board to the same hit rates every time", () => {
    const fields = {
      top_bets: [
        { key: "top1", label: "Seattle Seahawks -3", odds: "-110", price: -110, reason: "" },
        { key: "top2", label: "Over 45.5", odds: "-110", price: -110, reason: "" },
      ],
      player_props: [],
      fun_bets: [],
    } as never;
    const first = runSimulations(simulationSeedKey(game), picksToSimulate(fields), SIMULATION_RUNS);
    const second = runSimulations(simulationSeedKey(game), picksToSimulate(fields), SIMULATION_RUNS);
    expect(first.simulations).toEqual(second.simulations);
    expect(first.aggregate.picks.map((p) => p.hitRate)).toEqual(
      second.aggregate.picks.map((p) => p.hitRate),
    );
  });

  it("freezes the odds, availability report and seed used for the batch", () => {
    const dataset = datasetSnapshot(game);
    expect(dataset.seedKey).toBe(simulationSeedKey(game));
    expect(dataset.engineVersion).toBe(SIMULATION_ENGINE_VERSION);
    expect(dataset.runs).toBe(SIMULATION_RUNS);
    expect(dataset.book).toBe("DraftKings");
    expect(dataset.odds).toEqual(JSON.parse(JSON.stringify(odds)));
    expect(dataset.availability).toEqual([
      { team: "Arizona Cardinals", player: "Trey McBride", status: "questionable" },
    ]);
    expect(dataset.availabilityReported).toBe(true);
    // Stored with the batch, but never a reason to regenerate on its own.
    const snapshot = inputSnapshot(game);
    expect(snapshot.dataset?.seedKey).toBe(simulationSeedKey(game));
    const repulled = inputSnapshot({
      ...game,
      odds: { ...odds, capturedAt: "2026-09-20T15:40:00.000Z" },
    } as GameRow);
    expect(meaningfulInputChange(snapshot, repulled)).toBeNull();
  });
});
