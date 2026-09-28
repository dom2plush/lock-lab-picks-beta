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
