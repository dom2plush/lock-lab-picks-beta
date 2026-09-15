# Lock Lab Picks Beta

Build "Lock Lab", an NFL and College Football sports betting analysis web app with a clean, soft off-white/light-gray theme (no dark mode, no harsh pure white).

Key features to implement:
1. Header & Navigation:
   - Small "Lock Lab" logo/branding
   - Navigation links: Analyze, Historical Games, Record, Leaderboard, My Bets, and Auth/Profile

2. Main Analysis Page:
   - Sport selector (NFL / CFB toggle)
   - Matchup search input (e.g. "Broncos vs Chiefs") and quick-select cards for upcoming featured games
   - "Analyze Matchup" action triggering the Lock Lab betting formula engine
   - Output structured strictly in order:
     1) TOP 2 BETS: #1 best overall bet on the board + #2 next-best bet. Short explanation, exact line/odds logged. Color badges: 🟢 GREEN (strong bet), 🟡 YELLOW (playable with concerns), 🔴 RED (too close / low edge). No numeric percentages.
     2) BAD BET → OPPOSITE SIDE: Flags the worst bet on the board, evaluates the opposite side with reasoning (only recommended if it genuinely has edge).
     3) FUN BETS: Touchdowns, first TD, alternate spreads/totals.
     4) PLAYER PROPS: High-edge props with concise rationale.
   - "TAIL" button on every recommended pick: allows straight bet or parlay (with optional wager amount and extra custom legs; tracks only the Lock Lab leg for win/loss).

3. Shared Database & Backend (Supabase / Lovable Cloud):
   - Games table (NFL & CFB schedules, odds, lines, status, scores, pre-game Lock Lab picks)
   - Consistent analysis: all users see the exact same Lock Lab picks/lines for any given game
   - Historical games view: shows pre-game Lock Lab prediction, exact odds at that time, final score, and whether the #1 pick hit
   - User profiles with public usernames and follow system
   - Tails table: stores user tails, wager details, and tracks Lock Lab leg results
   - Record tracking: NFL record, CFB record, and Overall record tracking #1 Lock Lab picks

4. Pages:
   - "Record" tab: Clean record summary (NFL, CFB, Overall wins/losses for Lock Lab #1 picks)
   - "Leaderboard" tab: Top community tailers and member profiles
   - "My Bets" tab: User's saved tails, outcomes, and stats
   - User Auth: Signup/login with public username selection

Design: Simple, uncluttered, responsive sports-analytics aesthetic on off-white/light gray background with crisp typography and subtle cards.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/115666e9-0788-47b4-bf2a-dcb07d55eeb4).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
