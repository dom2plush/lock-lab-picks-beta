# Lock Lab roadmap

## Done
- Database: games, game_analyses, profiles, follows, tails + records/leaderboard views (RLS + grants)
- Odds pipeline: server-side The Odds API adapter (key stays in ODDS_API_KEY secret)
  - NFL + NCAAF schedules, spreads, moneylines, totals from a real book (DK/FD/MGM/Caesars priority)
  - Per-event alternate spreads/totals, team totals and player props
  - Sportsbook name + capture timestamp stored on every game and every pick
  - Final scores + grading pass; demo fixtures retired once live games land
- Analysis: snapshot stored with the pick is the snapshot displayed; regenerates when odds move
- UI: LIVE ODDS UNAVAILABLE banner (no feed) and per-game / per-section unavailable states
- Analysis engine rebuilt: market-first quant read (vig removal, key numbers, spread vs moneyline
  mispricing, hold, line movement) + handicap pass over QB, trenches, skill players, defence,
  game script and injuries; picks only from the real posted board; passes with RED when no edge;
  bad bet's opposite side graded independently. Formula changes stay manual — no self-learning.
- Pages: Analyze, Historical Games, Record, Leaderboard, My Bets, Auth
- Tail flow: straight or parlay, optional wager; only the Lock Lab leg is graded

## Open
- ODDS_API_KEY pending — until it's saved the app shows LIVE ODDS UNAVAILABLE and sample fixtures
- Player props require a props-enabled provider plan; shown as unavailable otherwise
- Schedule the refresh hook (`/api/public/hooks/refresh-sports-data`) on a cron once the key is in

## Alternate-line value layer (done)
- Every posted alternate spread/total is graded against the standard line: cash-chance gained vs break-even cost of the worse price, key-number crossings (3/7/10), capped key bump for short buys only, distance haircut so deep alternates never win on paper.
- Top 2 may be standard or alternate; an alternate pick displays the standard line it beat and why.
- Bad bet can surface a same-side better number ("Better alternative") instead of an opposite-side call.
- All alternate/standard prices are audited against the displayed snapshot; derivative markets allowed within a 15-minute refresh window. Alternates/team totals/props may come from a different book than the main line — each pick carries and displays its own book, line, price and capture time; core spread/total/ML must match the snapshot book; props must match the snapshot book.

## Bet-selection refinement (done)
- Line movement is a supporting signal only, never a prerequisite: evidence weights are price/value, QB, trenches, major injuries and matchup advantages (highest); skill matchups, game script, pace, usage (medium); movement, public info, narrative (supporting).
- Coverage statement per run: the engine is told exactly how many alternate spreads/totals/team totals/props the book supplied, and the verdict must say whether alternates were absent, evaluated and rejected, or selected.
- Bad bet prefers a market with a legitimately priced opposing selection; the posted flip side is matched from the board and graded independently. When the book posts no opposing price: "NO VALID BAD-BET FLIP".
- Displayed reasons capped at two sentences; deep reasoning stays internal.

## Published-site database connection (done)
- Games board reads through the server; real "Games could not be loaded" error state; sign-in/history pages receive public config at page load.

## Selection refinements (done, sim-v16)
- All player props (including ones the handicap read nominates) go through one edge-first selector: max 4, 1.5% soft diversity window.
- Alternate spreads that buy points must cross 3, 7 or 10 and gain 2+ covers of 50 simulated games; alternate totals must cross a sport-specific key total (NFL 37/40/41/43/44/47/51, CFB 45/48/51/52/55/58/59) with the same simulated check; alternates must match or beat the standard line's edge.
