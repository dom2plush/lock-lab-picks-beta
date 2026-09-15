import { BadgePill } from "@/components/badge-pill";
import type { TailTarget } from "@/components/tail-dialog";
import { Button } from "@/components/ui/button";
import type { AnalysisRow, GameRow } from "@/lib/lock-lab-types";
import { formatCapturedAt, formatKickoff, hasLiveOdds } from "@/lib/lock-lab-types";
import { buildAuditReport } from "@/lib/odds-audit";

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary font-display text-xs font-bold text-primary-foreground">
          {step}
        </span>
        <div>
          <h3 className="font-display text-xl leading-none font-semibold tracking-wide uppercase">
            {title}
          </h3>
          {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function AnalysisOutput({
  game,
  analysis,
  onTail,
  status = "pregame",
  propsVerified = true,
}: {
  game: GameRow;
  analysis: AnalysisRow;
  onTail: (target: TailTarget) => void;
  /** Pregame cards are tailable; locked/historical cards are read-only. */
  status?: "pregame" | "locked" | "historical";
  /** Whether the live feed returned any prop that passed verification. */
  propsVerified?: boolean;
}) {
  const live = hasLiveOdds(analysis.odds_snapshot) && !game.is_demo;
  const tailable = status === "pregame";
  // Recomputed from the very objects rendered below, so the check covers what
  // the user is actually looking at rather than what the server intended.
  const audit = buildAuditReport(analysis);

  const tailTarget = (
    pickKey: string,
    pickLabel: string,
    pickOdds: string | null,
    pickSection: TailTarget["pickSection"],
  ): TailTarget => ({
    gameId: game.id,
    analysisId: analysis.id,
    pickKey,
    pickLabel,
    pickOdds,
    pickSection,
  });

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-hairline bg-card p-5">
        <span className="eyebrow">{game.sport} · Lock Lab breakdown</span>
        <h2 className="mt-1 font-display text-2xl font-semibold">
          {game.away_team} at {game.home_team}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Kickoff {formatKickoff(game.commence_time)}
        </p>
        {live ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Lines from {analysis.odds_snapshot.bookmaker} · captured{" "}
            {formatCapturedAt(analysis.odds_captured_at ?? analysis.odds_snapshot.capturedAt)} ·
            every pick below is priced from this exact snapshot
          </p>
        ) : (
          <p className="mt-2 rounded-md border border-stop/40 bg-stop/10 px-3 py-2 text-xs font-semibold tracking-wide text-stop uppercase">
            Live odds unavailable — no sportsbook prices for this game
          </p>
        )}
        {game.injuries.length > 0 ? (
          <>
            <ul className="mt-3 flex flex-wrap gap-2">
              {game.injuries.slice(0, 6).map((injury, index) => (
                <li
                  key={`${injury.player}-${index}`}
                  className="rounded-full bg-surface px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {injury.player} — {injury.status}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Availability shown is the current reported injury list only. Any player not listed is
              of uncertain status — Lock Lab does not treat a missing designation as proof of health.
            </p>
          </>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Injury and availability data is uncertain for this game — no current report was returned,
            so nothing below claims a player is active or out.
          </p>
        )}
      </div>

      <Section step={1} title="Top 2 bets" subtitle="Best bet on the board, then the next best.">
        {analysis.top_bets.length === 0 && (
          <div className="rounded-lg border border-stop/40 bg-stop/10 p-4">
            <div className="flex items-center gap-2">
              <BadgePill badge="red" />
              <span className="font-display text-sm font-bold tracking-wide uppercase">No bet</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {analysis.verdict ??
                "No meaningful edge on this board. Lock Lab is passing rather than forcing a bet."}
            </p>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {analysis.top_bets.map((pick) => (
            <article key={pick.key} className="rounded-lg border border-hairline bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">#{pick.rank ?? 1} {pick.market}</span>
                <BadgePill badge={pick.badge} />
              </div>
              <p className="mt-2 font-display text-xl font-semibold">{pick.label}</p>
              <p className="mt-2 text-sm text-muted-foreground">{pick.reason}</p>
              {pick.standardLabel && (
                <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="eyebrow">Standard line</span>
                  <p className="mt-1 text-sm font-semibold">{pick.standardLabel}</p>
                  {pick.standardComparison && (
                    <p className="mt-1 text-xs text-muted-foreground">{pick.standardComparison}</p>
                  )}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Logged {pick.line ? `${pick.line} ` : ""}
                  {pick.odds ?? "—"}
                  {pick.book ? ` · ${pick.book}` : ""}
                  {pick.capturedAt ? ` · ${formatCapturedAt(pick.capturedAt)}` : ""}
                </span>
                {tailable && (
                  <Button
                    size="sm"
                    onClick={() =>
                      onTail(tailTarget(pick.key, pick.label, pick.odds ?? null, "top_bets"))
                    }
                  >
                    Tail
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Section>

      {analysis.bad_bet && (
        <Section
          step={2}
          title="Bad bet → opposite side"
          subtitle="The worst bet on the board, and whether flipping it actually has an edge."
        >
          <div className="rounded-lg border border-hairline bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="eyebrow">Avoid</span>
              <BadgePill badge={analysis.bad_bet.badge} />
            </div>
            <p className="mt-2 font-display text-xl font-semibold">{analysis.bad_bet.label}</p>
            <p className="mt-2 text-sm text-muted-foreground">{analysis.bad_bet.reason}</p>

            <div className="mt-4 rounded-md border border-hairline bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Opposite side</span>
                <BadgePill badge={analysis.bad_bet.oppositeBadge ?? "red"} />
              </div>
              <p className="mt-1 font-display text-lg font-semibold">
                {analysis.bad_bet.oppositeLabel}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {analysis.bad_bet.oppositeReason}
              </p>
              {analysis.bad_bet.oppositeRecommended && tailable ? (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    onTail(
                      tailTarget(
                        `${analysis.bad_bet!.key}-opposite`,
                        analysis.bad_bet!.oppositeLabel,
                        analysis.bad_bet!.oppositeOdds ?? null,
                        "bad_bet",
                      ),
                    )
                  }
                >
                  Tail the opposite side
                </Button>
              ) : (
                <p className="mt-3 text-xs font-semibold text-stop uppercase">
                  Not recommended — pass on both sides
                </p>
              )}
            </div>

            {analysis.bad_bet.alternateLabel && (
              <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">Better alternative — same side</span>
                  <BadgePill badge={analysis.bad_bet.alternateBadge ?? "yellow"} />
                </div>
                <p className="mt-1 font-display text-lg font-semibold">
                  {analysis.bad_bet.alternateLabel}
                </p>
                {analysis.bad_bet.alternateReason && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {analysis.bad_bet.alternateReason}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() =>
                    onTail(
                      tailTarget(
                        `${analysis.bad_bet!.key}-alternate`,
                        analysis.bad_bet!.alternateLabel!,
                        analysis.bad_bet!.alternateOdds ?? null,
                        "bad_bet",
                      ),
                    )
                  }
                >
                  Tail the better number
                </Button>
              </div>
            )}

          </div>
        </Section>
      )}

      <Section step={3} title="Fun bets" subtitle="Small-ticket swings: alternate lines and scoring.">
        {analysis.fun_bets.length === 0 && (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            Nothing here worth a ticket: no alternate line or scoring market on this game has a real
            matchup reason behind it. Lock Lab leaves the section empty rather than filling it.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          {analysis.fun_bets.map((bet) => (
            <article key={bet.key} className="rounded-lg border border-hairline bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">{bet.market}</span>
                <BadgePill badge={bet.badge} />
              </div>
              <p className="mt-2 font-display text-lg leading-tight font-semibold">{bet.label}</p>
              <p className="mt-2 text-sm text-muted-foreground">{bet.reason}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => onTail(tailTarget(bet.key, bet.label, bet.odds ?? null, "fun_bets"))}
              >
                Tail
              </Button>
            </article>
          ))}
        </div>
      </Section>

      <Section step={4} title="Player props" subtitle="Highest-edge props for this matchup.">
        {analysis.player_props.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {analysis.player_props.map((prop) => (
              <article key={prop.key} className="rounded-lg border border-hairline bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">{prop.market}</span>
                  <BadgePill badge={prop.badge} />
                </div>
                <p className="mt-2 font-display text-lg font-semibold">{prop.label}</p>
                <p className="mt-2 text-sm text-muted-foreground">{prop.reason}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() =>
                    onTail(tailTarget(prop.key, prop.label, prop.odds ?? null, "player_props"))
                  }
                >
                  Tail
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            No prop on this board has a real matchup or usage edge, so Lock Lab isn't posting one.
            Props only appear when the price and the role actually line up.
          </p>
        )}
      </Section>

      <Section
        step={5}
        title="Odds audit trail"
        subtitle="The exact price record behind every pick above, checked against the odds shown on this page."
      >
        <div className="rounded-lg border border-hairline bg-card">
          <div
            className={`flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3 text-xs font-semibold tracking-wide uppercase ${
              audit.verified ? "text-go" : "text-stop"
            }`}
          >
            <span>
              {audit.verified
                ? "Verified — every pick matches the displayed snapshot"
                : "Mismatch detected — do not bet these numbers"}
            </span>
            <span className="font-normal text-muted-foreground normal-case">
              {audit.snapshotBook ?? "No book"} · {formatCapturedAt(audit.snapshotCapturedAt)}
            </span>
          </div>

          {audit.entries.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              No picks were posted for this game, so there is nothing to audit.
            </p>
          ) : (
            <ul className="divide-y divide-hairline">
              {audit.entries.map((entry) => (
                <li key={`${entry.section}-${entry.pickKey}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="eyebrow">{entry.section}</span>
                    <span
                      className={`text-xs font-semibold tracking-wide uppercase ${
                        entry.problems.length ? "text-stop" : "text-go"
                      }`}
                    >
                      {entry.problems.length ? "Mismatch" : "Match"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-semibold">{entry.label}</p>
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <div>
                      <dt className="inline">Sportsbook: </dt>
                      <dd className="inline">{entry.book ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline">Line: </dt>
                      <dd className="inline">{entry.line ?? (entry.point != null ? entry.point : "—")}</dd>
                    </div>
                    <div>
                      <dt className="inline">Price: </dt>
                      <dd className="inline">{entry.displayedOdds ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline">Captured: </dt>
                      <dd className="inline">{formatCapturedAt(entry.capturedAt)}</dd>
                    </div>
                  </dl>
                  {entry.problems.map((problem) => (
                    <p key={problem} className="mt-1 text-xs font-medium text-stop">
                      {problem}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}
