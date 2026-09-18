# Rework Lock Lab Results

## Build
- Remove the Bad Bet / Opposite Side result from generation, storage, auditing, and display.
- Keep Top 2 as the two strongest independently graded spread, moneyline, total, or eligible market bets, with exact price provenance and existing confidence badges.
- Limit Player Props to 1–3 verified, valuable props and attach each prop’s hit rate from the stored 50-run batch. If the live feed has no qualifying prop, show that the market is unavailable rather than inventing one.
- Produce exactly one separate Fun Bet from a verified live market, prioritizing first-touchdown then anytime-touchdown offers, and label it as a higher-risk small-unit play.
- Use the stored simulation batch when Analyze is clicked; no display-time model call or additional simulation run.

## Technical details
- Extend deterministic simulation settlement to record prop/fun hit rates using the formula’s already-estimated candidate probabilities, seeded by the existing input fingerprint.
- Bump the simulation engine version so existing batches regenerate once during the weekly/on-change pipeline with the new result structure.
- Preserve the current page layout and styling while renumbering the remaining sections.
- Update odds-integrity checks and regression tests, then verify tests, preview build, and the Analyze interaction.
