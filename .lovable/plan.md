# Remove the separate Fun Bet and correct TD probabilities

## Changes
- Stop producing or rendering a separate Fun Bet section; retain the legacy stored field only for backward compatibility.
- Use the existing TD Scorers section as the fun-bet experience, with up to the required one verified Anytime TD and one verified First TD scorer for each team.
- Keep standard player props separate from touchdown scorer picks and preserve their current selection rules.
- Rework touchdown allocation inside each of the same 100 game simulations so each simulated team touchdown is assigned with realistic scorer and field probability, avoiding forced distinct scorers and inflated rates from small posted-player pools.
- Rank TD candidates from their resulting 100-run hit counts at their exact posted prices, without inventing missing markets or team identities.
- Bump the engine version so future analyses use the corrected probabilities while saved cards and tails remain immutable.

## Validation
- Update focused tests for no separate Fun Bet output, TD section composition, same-100-run settlement, and realistic Anytime/First TD rates.
- Run the full test suite and verify the preview build log is clean.
