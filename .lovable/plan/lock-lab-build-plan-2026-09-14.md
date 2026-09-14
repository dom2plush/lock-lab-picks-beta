# Lock Lab — build plan

A sports betting analysis app for NFL and College Football, with one shared set of Lock Lab picks that every user sees identically, tail tracking, and a public record.

## What you'll need from your side

- An odds provider key (The Odds API is the recommended fit — free tier covers NFL and NCAAF spreads, totals and moneylines). I'll ask for it securely when the backend is ready. Until it's in, the app runs on a small placeholder schedule so you can see the layout.
- Player props and first-touchdown markets are a paid add-on with most providers. If your key doesn't include them, those sections will show the markets we do have (alternate spreads/totals, team totals) and label props as unavailable rather than inventing numbers.

## Look and feel

Soft off-white background (not pure white), light-gray cards with hairline borders, one accent color for actions, and clear green/yellow/red badges. Crisp condensed headings with a clean body face. Mobile-first, no dark mode.

## Pages

1. **Analyze** (home) — NFL/CFB toggle, matchup search, cards for featured upcoming games, and an "Analyze Matchup" button.
2. **Historical Games** — past games with the pre-game Lock Lab pick, the exact line and odds at the time, final score, and whether the #1 pick hit.
3. **Record** — NFL, CFB and Overall win/loss for the #1 Lock Lab pick, with a win-rate bar and recent streak.
4. **Leaderboard** — top community tailers by record, linking to public profiles.
5. **My Bets** — your tails, wagers, outcomes and personal stats.
6. **Auth** — email and password signup with a public username, plus a profile page.

## Analysis output (fixed order)

1. **Top 2 Bets** — #1 best bet on the board and #2 next best, each with the exact line/odds logged and a short written reason, badged 🟢 / 🟡 / 🔴. No percentages shown anywhere.
2. **Bad Bet → Opposite Side** — flags the weakest bet on the board, then evaluates the other side and only recommends it if it genuinely has an edge.
3. **Fun Bets** — touchdown scorers, first TD, alternate spreads and totals.
4. **Player Props** — the highest-edge props with one-line rationale.

Every recommended pick carries a **TAIL** button: choose straight or parlay, optionally add a wager amount and your own extra legs. Only the Lock Lab leg decides win/loss for record purposes.

## How the picks stay identical for everyone

Picks are computed once per game and stored. The first analysis of a matchup runs the formula, writes the picks with the odds snapshot, and every later view reads that stored row — so two users never see different numbers. Picks lock when the game kicks off and are graded against the final score.

## Technical approach

- Lovable Cloud for database, auth and server logic.
- Tables: `games` (sport, teams, kickoff, status, odds snapshot, final score), `game_analyses` (the stored Lock Lab output per game, JSON sections + graded result), `profiles` (public username, follow-ready), `follows`, `tails` (user, analysis, pick reference, straight/parlay, wager, extra legs, Lock Lab leg result), and a `records` view aggregating #1-pick results by sport. RLS: public read on games/analyses/profiles/leaderboard aggregates, owner-only writes on tails and profiles.
- Odds ingestion and grading via TanStack server functions calling the provider, plus a scheduled refresh endpoint under `/api/public/` for line updates and final scores.
- Pick selection is a deterministic scoring formula (line vs. implied total, home/road splits, rest, market movement, price shopping) so it's reproducible; the short write-ups come from Lovable AI once per game and are stored with the pick.
- Grading job settles the #1 pick and all tails as finals arrive.

## Build order

1. Cloud backend, tables, RLS, auth with username signup.
2. Design system and shell — header, nav, theme.
3. Odds ingestion + games list, then the analysis engine and stored picks.
4. Analysis page output with badges and TAIL flow.
5. Historical, Record, Leaderboard, My Bets.
6. Grading and record rollups.
