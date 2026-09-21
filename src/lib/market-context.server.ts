/**
 * Market-trap context.
 *
 * Reads only completed games already stored in the database (real final
 * scores — nothing invented) and turns them into the two reads the market
 * itself is pricing against:
 *
 *  1. A simple opponent-neutral power margin from multi-week point
 *     differential, so one blowout cannot drag the read around.
 *  2. A "recency" margin built from last week alone — the number the casual
 *     public is effectively betting. Where that is far more aggressive than
 *     the posted line, the book is deliberately sitting short of the public
 *     price, which is the classic bait spot.
 *
 * Output is plain notes handed to the handicap pass. Nothing here sets a
 * probability or a price on its own.
 */
import type { GameRow, Sport } from "./lock-lab-types";

/** Home-field value in points, used for the neutral-to-posted comparison. */
const HOME_FIELD: Record<Sport, number> = { NFL: 1.8, CFB: 2.4 };
/** Margin at which a result counts as a blowout the public overreacts to. */
const BLOWOUT = 17;
/** Games of history used for the stable baseline. */
const FORM_GAMES = 5;

type FinalGame = {
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  commence_time: string;
};

export type TeamForm = {
  team: string;
  games: number;
  /** Average point differential across the sampled finals. */
  avgMargin: number;
  /** Point differential in the most recent final. */
  lastMargin: number | null;
  lastOpponent: string | null;
};

export type MarketContext = {
  notes: string[];
  home: TeamForm | null;
  away: TeamForm | null;
  /** Expected home margin from multi-week differentials plus home field. */
  baselineMargin: number | null;
  /** Expected home margin if you only watched last week. */
  recencyMargin: number | null;
  /** Home margin the posted spread implies. */
  marketMargin: number | null;
  /** recencyMargin - marketMargin: how far short of the public read the book is. */
  perceptionGap: number | null;
};

function marginFor(team: string, game: FinalGame): number | null {
  if (game.home_score == null || game.away_score == null) return null;
  if (game.home_team === team) return game.home_score - game.away_score;
  if (game.away_team === team) return game.away_score - game.home_score;
  return null;
}

function buildForm(team: string, games: FinalGame[]): TeamForm | null {
  const margins: { margin: number; opponent: string }[] = [];
  for (const game of games) {
    const margin = marginFor(team, game);
    if (margin == null) continue;
    margins.push({ margin, opponent: game.home_team === team ? game.away_team : game.home_team });
    if (margins.length >= FORM_GAMES) break;
  }
  if (!margins.length) return null;
  const sum = margins.reduce((acc, m) => acc + m.margin, 0);
  return {
    team,
    games: margins.length,
    avgMargin: sum / margins.length,
    lastMargin: margins[0]?.margin ?? null,
    lastOpponent: margins[0]?.opponent ?? null,
  };
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function describe(form: TeamForm | null, team: string): string {
  if (!form) return `${team}: no completed games with final scores are stored yet, so there is no form read.`;
  const last =
    form.lastMargin == null
      ? "no last-game result stored"
      : `last out ${signed(form.lastMargin)} vs ${form.lastOpponent}`;
  return `${team}: ${signed(form.avgMargin)} average point differential over ${form.games} completed game${
    form.games === 1 ? "" : "s"
  }; ${last}.`;
}

/**
 * Pulls stored finals for both teams and returns the market-trap read. Any
 * failure returns an empty context rather than a guess.
 */
export async function readMarketContext(
  game: GameRow,
  marketMargin: number | null,
): Promise<MarketContext> {
  const empty: MarketContext = {
    notes: [],
    home: null,
    away: null,
    baselineMargin: null,
    recencyMargin: null,
    marketMargin,
    perceptionGap: null,
  };

  let finals: FinalGame[] = [];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const teams = [game.home_team, game.away_team];
    const filter = teams
      .flatMap((t) => [`home_team.eq.${t}`, `away_team.eq.${t}`])
      .join(",");
    const { data, error } = await supabaseAdmin
      .from("games")
      .select("home_team, away_team, home_score, away_score, commence_time")
      .eq("sport", game.sport)
      .eq("is_demo", false)
      .lt("commence_time", game.commence_time)
      .not("home_score", "is", null)
      .not("away_score", "is", null)
      .or(filter)
      .order("commence_time", { ascending: false })
      .limit(60);
    if (error) throw error;
    finals = (data ?? []) as FinalGame[];
  } catch (err) {
    console.error("Lock Lab market context unavailable", err);
    return {
      ...empty,
      notes: [
        "FORM CONTEXT UNAVAILABLE: no stored completed results could be read for these teams, so no recency or market-trap read is available. Do not invent one.",
      ],
    };
  }

  const home = buildForm(game.home_team, finals);
  const away = buildForm(game.away_team, finals);
  const notes: string[] = [
    "RESULTS-BASED FORM (real stored final scores only):",
    describe(home, game.home_team),
    describe(away, game.away_team),
  ];

  let baselineMargin: number | null = null;
  let recencyMargin: number | null = null;
  let perceptionGap: number | null = null;

  if (home && away) {
    baselineMargin = home.avgMargin - away.avgMargin + HOME_FIELD[game.sport];
    notes.push(
      `Multi-week baseline: differentials plus ${HOME_FIELD[game.sport]} points of home field put the expected margin at ${signed(
        baselineMargin,
      )} to ${game.home_team}. This is a crude power read, not a fair line — weigh it against the matchup pillars.`,
    );

    if (home.lastMargin != null && away.lastMargin != null) {
      recencyMargin = home.lastMargin - away.lastMargin + HOME_FIELD[game.sport];
      notes.push(
        `Last-week-only read (what the casual market is reacting to): ${signed(recencyMargin)} to ${game.home_team}.`,
      );

      if (marketMargin != null) {
        perceptionGap = recencyMargin - marketMargin;
        if (Math.abs(perceptionGap) >= 4) {
          const publicSide = perceptionGap > 0 ? game.home_team : game.away_team;
          const contrarian = perceptionGap > 0 ? game.away_team : game.home_team;
          notes.push(
            `MARKET TRAP CHECK: last week's results point ${Math.abs(perceptionGap).toFixed(
              1,
            )} points more aggressively toward ${publicSide} than the posted spread does. The book is refusing to price the public read, which historically favours ${contrarian}. Treat this as a reason to look hard at ${contrarian}, not as proof on its own — confirm it with the trenches, QB and injury pillars before using it.`,
          );
        } else {
          notes.push(
            "MARKET TRAP CHECK: the posted spread is in line with what last week's results suggest, so there is no perception gap to exploit here.",
          );
        }
      }
    }

    if (baselineMargin != null && marketMargin != null) {
      const gap = baselineMargin - marketMargin;
      notes.push(
        Math.abs(gap) >= 3
          ? `Baseline vs market: the multi-week read is ${Math.abs(gap).toFixed(1)} points off the posted number, leaning ${
              gap > 0 ? game.home_team : game.away_team
            }.`
          : "Baseline vs market: the multi-week read and the posted number agree within 3 points.",
      );
    }
  }

  for (const form of [home, away]) {
    if (!form || form.lastMargin == null || form.games < 2) continue;
    const rest = (form.avgMargin * form.games - form.lastMargin) / (form.games - 1);
    if (Math.abs(form.lastMargin) >= BLOWOUT && Math.abs(form.lastMargin - rest) >= 10) {
      notes.push(
        form.lastMargin > 0
          ? `RECENCY WARNING: ${form.team} won by ${form.lastMargin} last out but averages ${signed(
              rest,
            )} otherwise. Blowout winners are routinely overpriced the following week — do not let last week's scoreline carry a pick.`
          : `RECENCY WARNING: ${form.team} lost by ${Math.abs(form.lastMargin)} last out but averages ${signed(
              rest,
            )} otherwise. Blowout losers are routinely underpriced the following week — the market may be too low on them.`,
      );
    }
  }

  return { notes, home, away, baselineMargin, recencyMargin, marketMargin, perceptionGap };
}
