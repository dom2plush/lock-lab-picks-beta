# Fix betting analysis fallbacks

## Scope
- Keep the current pages, layout, components, formula weights, tables, and live-data integrity rules unchanged.
- Change only the existing analysis pipeline and its focused regression tests.

## Implementation
1. Replace the blanket AI-read failure pass with a deterministic market-board fallback that ranks only candidates already graded by the existing formula. It will publish up to two qualifying, distinct bets and otherwise return a truthful no-edge verdict.
2. Apply matchup leans before shopping same-side alternate ladders, so standard and alternate candidates are compared under the same supported read.
3. Independently gate the bad bet and its opposite with each candidate’s own probability, EV, uncertainty, and threshold result. If the opposite fails, mark both sides as pass.
4. Preserve derivative fetch attempts independently, so one unavailable market query cannot erase alternate lines returned by another query. Missing derivatives will not block standard markets.
5. Preserve exact line, price, sportsbook, and capture timestamp on every selected candidate and retain the existing audit gate.
6. Add regression coverage for deterministic fallback picks, opposite-side rejection, and partial alternate-market retrieval.

## Verification
- Run the existing focused tests and TypeScript check.
- Confirm the preview build is clean and exercise a live game analysis without changing the UI.
