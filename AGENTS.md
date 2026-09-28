<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Simulation architecture
- Every market (ML, spread, total, alternate, player prop) is settled against the exact same 100 simulated scorelines produced by `simulateGame`; player outcomes are drawn inside those same trials. Rationale: one distribution keeps standard and alternate prices internally consistent and prevents a separate prop model from contradicting the game script.
- TD Scorers is the only fun-bet surface; separate Fun Bet output is legacy-empty. Touchdown scorers include an unlisted-field share and allow repeat scorers so a partial sportsbook player pool cannot inflate probabilities.
- All randomness (scores, player draws, pick settlement) is seeded from `simulationSeedKey(game)` = game id + `SIMULATION_ENGINE_VERSION`, never from capture timestamps or fair-line values. Rationale: identical inputs must reproduce identical runs for every user and every regeneration.
- Each stored batch freezes its dataset in `input_snapshot.dataset` (full odds snapshot, complete availability report, seed key, engine version, run count). Rationale: the published card must be auditable against exactly the data it was computed from; the dataset is record-only and never triggers regeneration.
- Bump CARD_SELECTION_VERSION (not SIMULATION_ENGINE_VERSION) when only pick selection changes; it rebuilds saved cards once without changing simulation seeds.
