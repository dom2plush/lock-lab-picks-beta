# Lock Lab roadmap

## Done
- Database: games, game_analyses, profiles, follows, tails + records/leaderboard views (RLS + grants)
- Demo schedule: 12 upcoming + 10 graded games (NFL & CFB)
- Odds pipeline: provider client, ingestion + grading pass, `/api/public/hooks/refresh-sports-data`
- Lock Lab formula engine (deterministic) + AI-written reasoning, stored once per game
- Pages: Analyze, Historical Games, Record, Leaderboard, My Bets, Auth (email + username)
- Tail flow: straight or parlay, optional wager, extra legs; only the Lock Lab leg is graded

## Open (waiting on the user)
- ODDS_API_KEY not yet provided — live schedules, odds and final scores stay on demo data until it is
- Player props / first-TD markets require a props-enabled odds plan; shown as unavailable until then
