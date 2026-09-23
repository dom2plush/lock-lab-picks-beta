import type { AnalysisRow, GameRow, MarketOffer, Sport } from "./lock-lab-types";
import { gradePick } from "./grading.server";
import {
  fetchEventMarkets,
  fetchInjuries,
  fetchScheduledEvents,
  fetchScores,
  fetchUpcomingGames,
  getCreditsRemaining,
  hasProviderKey,
} from "./odds-provider.server";
import { inputFingerprint } from "./simulation.server";

/**
 * Provider credits the automatic sync always leaves untouched, so Analyze taps
 * can still pull fresh lines. Below this the sync keeps the free schedule and
 * injury refresh going and skips paid calls.
 */
const LINE_CREDIT_RESERVE = 100;
/** Automatic player-prop refresh costs many credits per game; only run it with ample credits. */
const PROP_CREDIT_FLOOR = 1500;
/** Only games kicking off within this window get an automatic prop refresh. */
const PROP_WINDOW_HOURS = 36;

const SPORTS: Sport[] = ["NFL", "CFB"];

export { hasProviderKey };

export type SyncReport = {
  providerConnected: boolean;
  startedAt: string;
  finishedAt: string | null;
  scheduledGamesSeen: number;
  newGames: number;
  linesChanged: number;
  propsRefreshed: number;
  propsChanged: number;
  creditsRemaining: number | null;
  skipped: string[];
  gamesUpserted: number;
  scoresUpdated: number;
  demoGamesRetired: number;
  analysesGraded: number;
  tailsGraded: number;
  errors: string[];
};

/**
 * Pull the live odds board for one game (plus its alternate/prop markets) and
 * store it with the sportsbook and capture timestamp attached.
 */
export async function refreshGameOdds(game: GameRow): Promise<GameRow | null> {
  if (!hasProviderKey() || game.is_demo) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  try {
    const [board, injuriesByTeam] = await Promise.all([
      fetchUpcomingGames(game.sport),
      fetchInjuries(game.sport),
    ]);
    const match = board.find((g) => g.provider_game_id === game.provider_game_id);
    if (!match) return null;

    let props: MarketOffer[] = [];
    let propsUpdatedAt: string | null = null;
    try {
      const markets = await fetchEventMarkets(game.sport, game.provider_game_id);
      props = [...markets.alternates, ...markets.props];
      // Always stamp the pull, even when the board came back empty: that is the
      // difference between "no alternate market exists" and "never asked".
      propsUpdatedAt = markets.capturedAt;
      console.info(
        `[odds] derivative coverage ${game.away_team} @ ${game.home_team}:`,
        JSON.stringify(markets.coverage),
      );
    } catch {
      // Derivative markets are optional; the main board still stands.
    }

    const update = {
      odds: match.odds,
      odds_book: match.odds_book,
      odds_book_key: match.odds_book_key,
      odds_updated_at: match.odds_updated_at,
      injuries: [
        ...(injuriesByTeam.get(game.home_team) ?? []),
        ...(injuriesByTeam.get(game.away_team) ?? []),
      ],
      ...(propsUpdatedAt ? { props, props_updated_at: propsUpdatedAt } : {}),
      updated_at: new Date().toISOString(),
    };


    const { data, error } = await supabaseAdmin
      .from("games")
      .update(update as never)
      .eq("id", game.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as GameRow) ?? null;
  } catch (error) {
    console.error("[odds] single-game refresh failed", (error as Error).message);
    return null;
  }
}

/**
 * Full ingestion pass: schedules + odds, injuries, final scores, then grading.
 * Once live games land for a sport, the seeded demo fixtures for that sport are
 * retired so sample lines can never sit next to real ones.
 */
export async function syncSportsData(): Promise<SyncReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const report: SyncReport = {
    providerConnected: hasProviderKey(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    scheduledGamesSeen: 0,
    newGames: 0,
    linesChanged: 0,
    propsRefreshed: 0,
    propsChanged: 0,
    creditsRemaining: null,
    skipped: [],
    gamesUpserted: 0,
    scoresUpdated: 0,
    demoGamesRetired: 0,
    analysesGraded: 0,
    tailsGraded: 0,
    errors: [],
  };

  const creditsOk = (reserve: number) => {
    const left = getCreditsRemaining();
    return left == null || left > reserve;
  };

  if (report.providerConnected) {
    for (const sport of SPORTS) {
      let liveGames = 0;

      // Existing rows: used to detect new games and changed markets without
      // ever creating a duplicate (sport + provider id is unique).
      const { data: existingRows } = await supabaseAdmin
        .from("games")
        .select("*")
        .eq("sport", sport);
      const existing = new Map(
        ((existingRows ?? []) as unknown as GameRow[]).map((g) => [g.provider_game_id, g]),
      );

      // 1. Full schedule (free): every listed game, including later kickoffs
      //    and games books have not priced yet.
      let schedule: Awaited<ReturnType<typeof fetchScheduledEvents>> = [];
      try {
        schedule = await fetchScheduledEvents(sport);
        report.scheduledGamesSeen += schedule.length;
      } catch (error) {
        report.errors.push(`${sport} schedule: ${(error as Error).message}`);
      }

      let injuries = new Map<string, GameRow["injuries"]>();
      try {
        injuries = await fetchInjuries(sport);
      } catch (error) {
        report.errors.push(`${sport} injuries: ${(error as Error).message}`);
      }
      const injuriesFor = (home: string, away: string) => [
        ...(injuries.get(home) ?? []),
        ...(injuries.get(away) ?? []),
      ];

      // 2. Main sportsbook lines (paid), kept inside the credit reserve.
      const priced = new Set<string>();
      if (creditsOk(LINE_CREDIT_RESERVE)) {
        try {
          const games = await fetchUpcomingGames(sport);
          const rows = games.map((game) => ({
            ...game,
            injuries: injuriesFor(game.home_team, game.away_team),
            updated_at: new Date().toISOString(),
          }));
          for (const row of rows) {
            priced.add(row.provider_game_id);
            const before = existing.get(row.provider_game_id);
            if (!before) continue;
            const changed =
              inputFingerprint(before) !==
              inputFingerprint({ ...before, odds: row.odds, injuries: row.injuries } as GameRow);
            if (changed) report.linesChanged += 1;
          }
          if (rows.length) {
            const { error } = await supabaseAdmin
              .from("games")
              .upsert(rows as never, { onConflict: "sport,provider_game_id" });
            if (error) throw new Error(error.message);
            report.gamesUpserted += rows.length;
            liveGames = rows.length;
          }
        } catch (error) {
          report.errors.push(`${sport} odds: ${(error as Error).message}`);
        }
      } else {
        report.skipped.push(`${sport} lines: provider credits at or below the ${LINE_CREDIT_RESERVE}-credit reserve`);
      }

      // 3. Scheduled games with no line yet: add new ones, never overwrite a
      //    stored price; existing unpriced games get fresh kickoff + injuries.
      const unpriced = schedule.filter((g) => !priced.has(g.provider_game_id));
      const fresh = unpriced
        .filter((g) => !existing.has(g.provider_game_id))
        .map((g) => ({
          ...g,
          injuries: injuriesFor(g.home_team, g.away_team),
          updated_at: new Date().toISOString(),
        }));
      if (fresh.length) {
        const { data: inserted, error } = await supabaseAdmin
          .from("games")
          .upsert(fresh as never, { onConflict: "sport,provider_game_id", ignoreDuplicates: true })
          .select("id");
        if (error) report.errors.push(`${sport} schedule insert: ${error.message}`);
        else liveGames += inserted?.length ?? 0;
      }
      for (const g of schedule) {
        const before = existing.get(g.provider_game_id);
        if (!before) {
          report.newGames += 1;
          continue;
        }
        if (priced.has(g.provider_game_id)) continue;
        const nextInjuries = injuriesFor(g.home_team, g.away_team);
        const kickoffMoved = new Date(before.commence_time).getTime() !== new Date(g.commence_time).getTime();
        const injuriesMoved =
          inputFingerprint(before) !== inputFingerprint({ ...before, injuries: nextInjuries } as GameRow);
        if (!kickoffMoved && !injuriesMoved) continue;
        if (injuriesMoved) report.linesChanged += 1;
        const { error } = await supabaseAdmin
          .from("games")
          .update({
            commence_time: g.commence_time,
            injuries: nextInjuries as never,
            updated_at: new Date().toISOString(),
          })
          .eq("id", before.id);
        if (error) report.errors.push(`${sport} schedule update: ${error.message}`);
      }

      if (liveGames > 0) {
        const { data: retired } = await supabaseAdmin
          .from("games")
          .delete()
          .eq("sport", sport)
          .eq("is_demo", true)
          .neq("status", "final")
          .select("id");
        report.demoGamesRetired += retired?.length ?? 0;
      }

      // 4. Final scores (paid), inside the reserve.
      if (creditsOk(LINE_CREDIT_RESERVE)) {
        try {
          const scores = await fetchScores(sport);
          for (const score of scores) {
            const { error } = await supabaseAdmin
              .from("games")
              .update({
                status: score.status,
                home_score: score.home_score,
                away_score: score.away_score,
                updated_at: new Date().toISOString(),
              })
              .eq("sport", sport)
              .eq("provider_game_id", score.provider_game_id);
            if (!error) report.scoresUpdated += 1;
          }
        } catch (error) {
          report.errors.push(`${sport} scores: ${(error as Error).message}`);
        }
      } else {
        report.skipped.push(`${sport} scores: provider credits at or below the reserve`);
      }

      // 5. Alternate lines + player props for games kicking off soon — only
      //    with ample credits, since each game costs many provider credits.
      //    The whole posted board replaces the stored one, so markets never
      //    duplicate; unchanged boards are left alone.
      if (creditsOk(PROP_CREDIT_FLOOR)) {
        const now = Date.now();
        const horizon = now + PROP_WINDOW_HOURS * 60 * 60 * 1000;
        const { data: soon } = await supabaseAdmin
          .from("games")
          .select("id, provider_game_id, props, home_team, away_team")
          .eq("sport", sport)
          .eq("status", "scheduled")
          .eq("is_demo", false)
          .gte("commence_time", new Date(now).toISOString())
          .lte("commence_time", new Date(horizon).toISOString());
        const strip = (offers: MarketOffer[]) =>
          JSON.stringify(
            offers
              .map(({ capturedAt: _c, ...rest }) => rest)
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          );
        for (const game of (soon ?? []) as unknown as (Pick<GameRow, "id" | "provider_game_id" | "home_team" | "away_team"> & { props: MarketOffer[] })[]) {
          if (!creditsOk(PROP_CREDIT_FLOOR)) break;
          try {
            const markets = await fetchEventMarkets(sport, game.provider_game_id);
            const offers = [...markets.alternates, ...markets.props];
            report.propsRefreshed += 1;
            const changed = strip(offers) !== strip((game.props ?? []) as MarketOffer[]);
            const { error } = await supabaseAdmin
              .from("games")
              .update(
                (changed
                  ? { props: offers, props_updated_at: markets.capturedAt }
                  : { props_updated_at: markets.capturedAt }) as never,
              )
              .eq("id", game.id);
            if (error) throw new Error(error.message);
            if (changed) report.propsChanged += 1;
          } catch (error) {
            report.errors.push(
              `${sport} props ${game.away_team} @ ${game.home_team}: ${(error as Error).message}`,
            );
          }
        }
      } else {
        report.skipped.push(
          `${sport} props: automatic refresh needs more than ${PROP_CREDIT_FLOOR} provider credits; props still refresh on Analyze`,
        );
      }
    }
  }

  // ---- grade ungraded #1 picks and the Lock Lab leg of every tail ----
  const { data: pending } = await supabaseAdmin
    .from("game_analyses")
    .select("*, games!inner(*)")
    .eq("top_pick_result", "pending")
    .eq("games.status", "final");

  for (const row of (pending ?? []) as unknown as (AnalysisRow & { games: GameRow })[]) {
    const result = gradePick(row.top_bets?.[0], row.games);
    if (result === "pending") continue;
    await supabaseAdmin
      .from("game_analyses")
      .update({ top_pick_result: result, graded_at: new Date().toISOString() })
      .eq("id", row.id);
    report.analysesGraded += 1;
  }

  // Tails grade on their own locked snapshot (market, side, line), never on
  // whatever the game's current Lock Lab card happens to say.
  const { data: openTails } = await supabaseAdmin
    .from("tails")
    .select("id, market, selection, line_point, games!inner(*)")
    .eq("lock_leg_result", "pending")
    .eq("games.status", "final");

  for (const tail of (openTails ?? []) as unknown as {
    id: string;
    market: string | null;
    selection: string | null;
    line_point: number | null;
    games: GameRow;
  }[]) {
    if (!tail.market || !tail.selection) continue;
    const result = gradePick(
      {
        key: tail.id,
        badge: "yellow",
        label: "",
        reason: "",
        market: tail.market,
        selection: tail.selection,
        line: tail.line_point != null ? String(tail.line_point) : null,
        point: tail.line_point,
      },
      tail.games,
    );
    if (result === "pending") continue;
    await supabaseAdmin
      .from("tails")
      .update({ lock_leg_result: result, graded_at: new Date().toISOString() })
      .eq("id", tail.id);
    report.tailsGraded += 1;
  }

  report.creditsRemaining = getCreditsRemaining();
  report.finishedAt = new Date().toISOString();
  const summary = `[sync] ${report.errors.length ? "finished with errors" : "ok"} ${JSON.stringify(report)}`;
  if (report.errors.length) console.error(summary);
  else console.info(summary);
  return report;
}
