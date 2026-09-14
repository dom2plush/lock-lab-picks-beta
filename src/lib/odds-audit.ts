/**
 * Odds audit trail.
 *
 * Every Lock Lab pick carries the exact price record the engine used: line,
 * American price, sportsbook and capture timestamp. This module rebuilds that
 * record from a stored analysis and hard-checks it against the odds snapshot
 * the page is displaying, so a pick can never quietly show a different number
 * than the one it was graded from.
 *
 * Pure and client-safe: the server runs it before writing an analysis, and the
 * UI runs the same code over the exact objects it renders.
 */
import type { AnalysisRow, BadBet, FunBet, GameOdds, PickBet, PropBet } from "./lock-lab-types";

export function formatAmerican(price: number | null | undefined): string | null {
  if (price == null || !Number.isFinite(price)) return null;
  return price > 0 ? `+${price}` : String(price);
}

export type AuditSection = "Top bet" | "Bad bet" | "Opposite side" | "Fun bet" | "Player prop";

export type AuditEntry = {
  section: AuditSection;
  pickKey: string;
  /** Exactly the selection text rendered to the user. */
  label: string;
  market: string;
  line: string | null;
  /** Price string rendered to the user. */
  displayedOdds: string | null;
  /** Price the engine actually used. */
  price: number | null;
  point: number | null;
  book: string | null;
  capturedAt: string | null;
  /** Empty when this pick reconciles with the displayed snapshot. */
  problems: string[];
};

export type AuditReport = {
  snapshotBook: string | null;
  snapshotCapturedAt: string | null;
  entries: AuditEntry[];
  /** True when every pick reconciles with the displayed odds snapshot. */
  verified: boolean;
  problems: string[];
};

type SourceLike = {
  point?: number | null;
  price?: number | null;
  book?: string | null;
  capturedAt?: string | null;
};

function sameTime(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

function sameBook(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function checkEntry(
  section: AuditSection,
  pickKey: string,
  label: string,
  market: string,
  line: string | null,
  displayedOdds: string | null,
  source: SourceLike,
  snapshot: GameOdds,
): AuditEntry {
  const problems: string[] = [];

  if (source.price == null) problems.push("No price was recorded for this pick.");
  if (!source.book) problems.push("No sportsbook was recorded for this pick.");
  if (!source.capturedAt) problems.push("No capture timestamp was recorded for this pick.");

  const expected = formatAmerican(source.price ?? null);
  if (expected && displayedOdds && expected !== displayedOdds) {
    problems.push(`Displayed price ${displayedOdds} does not match the recorded price ${expected}.`);
  }
  if (expected && !displayedOdds) problems.push("The price is recorded but not shown with the pick.");

  if (snapshot.bookmaker && source.book && !sameBook(source.book, snapshot.bookmaker)) {
    problems.push(
      `Priced at ${source.book} but the page is showing a ${snapshot.bookmaker} snapshot.`,
    );
  }
  if (snapshot.capturedAt && source.capturedAt && !sameTime(source.capturedAt, snapshot.capturedAt)) {
    problems.push("This pick was priced from a different snapshot than the one displayed.");
  }

  return {
    section,
    pickKey,
    label,
    market,
    line,
    displayedOdds,
    price: source.price ?? null,
    point: source.point ?? null,
    book: source.book ?? null,
    capturedAt: source.capturedAt ?? null,
    problems,
  };
}

type AuditInput = {
  odds_snapshot: GameOdds;
  top_bets: PickBet[];
  bad_bet: BadBet | null;
  fun_bets: FunBet[];
  player_props: PropBet[];
};

/** Rebuild the audit trail for an analysis and reconcile it with its snapshot. */
export function buildAuditReport(analysis: AuditInput | AnalysisRow): AuditReport {
  const snapshot = analysis.odds_snapshot ?? {};
  const entries: AuditEntry[] = [];

  for (const bet of analysis.top_bets ?? []) {
    entries.push(
      checkEntry(
        "Top bet",
        bet.key,
        bet.label,
        bet.market,
        bet.line ?? null,
        bet.odds ?? null,
        bet,
        snapshot,
      ),
    );
  }

  const bad = analysis.bad_bet;
  if (bad) {
    entries.push(
      checkEntry("Bad bet", bad.key, bad.label, "Flagged", null, formatAmerican(bad.price), bad, snapshot),
    );
    if (bad.oppositePrice != null || bad.oppositeBook || bad.oppositeCapturedAt) {
      entries.push(
        checkEntry(
          "Opposite side",
          `${bad.key}-opposite`,
          bad.oppositeLabel,
          "Opposite",
          null,
          bad.oppositeOdds ?? null,
          {
            point: bad.oppositePoint ?? null,
            price: bad.oppositePrice ?? null,
            book: bad.oppositeBook ?? null,
            capturedAt: bad.oppositeCapturedAt ?? null,
          },
          snapshot,
        ),
      );
    }
  }

  for (const bet of analysis.fun_bets ?? []) {
    entries.push(
      checkEntry("Fun bet", bet.key, bet.label, bet.market, null, bet.odds ?? null, bet, snapshot),
    );
  }

  for (const prop of analysis.player_props ?? []) {
    entries.push(
      checkEntry("Player prop", prop.key, prop.label, prop.market, null, prop.odds ?? null, prop, snapshot),
    );
  }

  const problems = entries.flatMap((e) => e.problems.map((p) => `${e.label}: ${p}`));

  return {
    snapshotBook: snapshot.bookmaker ?? null,
    snapshotCapturedAt: snapshot.capturedAt ?? null,
    entries,
    verified: problems.length === 0,
    problems,
  };
}

/**
 * Hard check run on the server before an analysis is stored. Any pick whose
 * price record does not reconcile with the snapshot is removed rather than
 * published — Lock Lab never shows a number it cannot prove.
 */
export function enforceAuditIntegrity<T extends AuditInput>(
  output: T,
  snapshot: GameOdds,
): { output: T; report: AuditReport; dropped: string[] } {
  const withSnapshot = { ...output, odds_snapshot: snapshot };
  const report = buildAuditReport(withSnapshot);
  const failed = new Set(
    report.entries.filter((e) => e.problems.length > 0 && e.section !== "Opposite side").map((e) => e.pickKey),
  );
  const oppositeFailed = report.entries.some(
    (e) => e.section === "Opposite side" && e.problems.length > 0,
  );

  if (!failed.size && !oppositeFailed) return { output, report, dropped: [] };

  const dropped = report.entries.filter((e) => e.problems.length > 0).map((e) => e.label);

  const cleaned: T = {
    ...output,
    top_bets: output.top_bets.filter((b) => !failed.has(b.key)),
    fun_bets: output.fun_bets.filter((b) => !failed.has(b.key)),
    player_props: output.player_props.filter((b) => !failed.has(b.key)),
    bad_bet:
      output.bad_bet && failed.has(output.bad_bet.key)
        ? null
        : output.bad_bet && oppositeFailed
          ? {
              ...output.bad_bet,
              oppositeRecommended: false,
              oppositeBadge: "red" as const,
              oppositeReason:
                "The opposite side could not be reconciled with the displayed odds snapshot, so Lock Lab is not posting it.",
            }
          : output.bad_bet,
  };

  return {
    output: cleaned,
    report: buildAuditReport({ ...cleaned, odds_snapshot: snapshot }),
    dropped,
  };
}
