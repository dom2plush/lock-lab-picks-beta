# Direct live Formula Analysis

## Goal
Replace the stored 50-simulation gate with an immediate Analyze flow that refreshes the selected real game, runs the current Lock Lab formula once, validates every selection against the live board, and saves the generated card for history and grading.

## Changes
- Make **Analyze Matchup** refresh the selected game’s latest standard odds, alternate markets, player props, injuries, and available matchup inputs before running the formula.
- Run the current market-first Lock Lab formula immediately on click; remove all simulation-batch reads, writes, fingerprints, hit rates, and “scheduled batch” fallback behavior.
- Persist each generated card with the exact sportsbook, numeric line, American price, and provider capture timestamp attached to every Top 2, Player Prop, and Fun Bet.
- Keep post-kickoff cards immutable and preserve existing history, record grading, accounts, tails, game selection, and NFL/CFB tabs.
- Disable and remove only the weekly simulation endpoint/jobs and simulation storage path; retain the live sports-data refresh and grading schedule.

## Output contract
- **Top 2 Bets:** rank the two strongest distinct, real posted candidates and return exactly two when the live standard board contains at least two valid prices. Each includes traffic-light confidence and short reasoning.
- **Player Props:** return 1–3 only from verified posted prop records that the formula independently supports. If the provider supplies no supportable player prop, mark that section unavailable rather than inventing one.
- **Fun Bet:** select exactly one verified posted higher-variance market, prioritizing First TD then Anytime TD. If no such real market is supplied, mark only this section unavailable rather than substituting a fake price.
- Remove Bad Bet, Opposite, simulation language, simulation hit rates, the Odds Audit display section, and the generic “DATA CONNECTION REQUIRED” copy from the visible result structure.

## Data integrity
- Reject any selection not present in the selected game’s verified provider records.
- Keep the exact odds snapshot and per-pick provenance in `game_analyses` for later line-movement comparison and grading.
- A failed derivative-market request does not invalidate working standard odds or other successfully returned markets.

## Verification
- Add regression coverage for direct Analyze execution, exact two-bet ranking, prop/fun cardinality, provenance persistence, and immutable post-kickoff reads.
- Run type validation and the full test suite.
- Use a currently available real NFL or CFB game to verify Analyze returns the saved live card; confirm no fake/demo record reaches the formula and no simulation system is invoked.
