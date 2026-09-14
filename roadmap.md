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
- All alternate/standard prices are audited against the displayed snapshot; derivative markets allowed within a 15-minute refresh window.
