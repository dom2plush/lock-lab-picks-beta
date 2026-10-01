import { BadgePill } from "@/components/badge-pill";
import type { TailTarget } from "@/components/tail-dialog";
import { Button } from "@/components/ui/button";
import type { AnalysisRow, GameRow, PickSource, LineMetrics } from "@/lib/lock-lab-types";
import { formatCapturedAt, formatKickoff, hasLiveOdds, isTouchdownPick } from "@/lib/lock-lab-types";

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

const pct = (v: number | null | undefined, signed = false) =>
  v == null || !Number.isFinite(v) ? "—" : `${signed && v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/** Base (500) vs Stress (500) vs Combined (1,000) read for one pick. */
function LineTable({ title, rows }: { title: string; rows: LineMetrics[] }) {
  return (
    <div>
      <span className="eyebrow">{title}</span>
      <div className="mt-1 grid gap-1 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap justify-between gap-x-3">
            <span className="font-semibold">
              {r.label} ({r.price > 0 ? `+${r.price}` : r.price})
            </span>
            <span className="text-muted-foreground">
              {pct(r.hitRate)} sim · base {pct(r.baseHitRate)} / stress {pct(r.stressHitRate)} · edge {pct(r.edge, true)} · ROI{" "}
              {pct(r.roi, true)}
              {r.pushRate ? ` · push ${pct(r.pushRate)}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimBreakdown({ pick, full = false }: { pick: PickSource & { label?: string }; full?: boolean }) {
  if (pick.baseHitRate == null || pick.stressHitRate == null) return null;
  const cells: [string, string, string][] = [
    ["Base model", "500 sims", pct(pick.baseHitRate)],
    ["Stress test", "500 sims", pct(pick.stressHitRate)],
    ["Combined", "1,000 sims", pct(pick.combinedHitRate)],
    ["Agreement", "base vs stress", pick.agreementLevel ?? "—"],
  ];
  return (
    <div className="mt-3 space-y-3 rounded-md border border-hairline bg-surface p-3">
      <span className="eyebrow">Simulation breakdown</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cells.map(([title, sub, value]) => (
          <div key={title}>
            <p className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">{title}</p>
            <p className="font-display text-base font-semibold">{value}</p>
            <p className="text-[0.65rem] text-muted-foreground">{sub}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <span>Model edge <b>{pct(pick.combinedEdge, true)}</b></span>
        <span>Stress edge <b>{pct(pick.stressEdge, true)}</b></span>
        <span>Market implied <b>{pct(pick.impliedProbability)}</b></span>
        <span>Expected ROI <b>{pct(pick.expectedRoi, true)}</b></span>
        {pick.pushRate != null && pick.pushRate > 0 && <span>Push <b>{pct(pick.pushRate)}</b></span>}
      </div>
      {full && pick.standardMetrics && (
        <p className="text-xs text-muted-foreground">
          Standard line: hits {pct(pick.standardMetrics.hitRate)} vs break-even {pct(pick.standardMetrics.implied)} · edge{" "}
          {pct(pick.standardMetrics.edge, true)} · ROI {pct(pick.standardMetrics.roi, true)}
          {(pick.standardMetrics.roi ?? 0) > (pick.expectedRoi ?? 0)
            ? " — the alternate hits more often but returns less per unit; it was chosen on hit rate and robustness."
            : ""}
        </p>
      )}
      {full && pick.lineComparison && pick.lineComparison.length > 1 && (
        <LineTable title="Key-number check" rows={pick.lineComparison} />
      )}
      {full && pick.totalComparison && (
        <LineTable
          title={`Both sides · stronger: ${pick.totalComparison.stronger}`}
          rows={[pick.totalComparison.over, pick.totalComparison.under]}
        />
      )}
      {full && pick.whyComponents && pick.whyComponents.length > 0 && (
        <div>
          <span className="eyebrow">Why Lock Lab likes this</span>
          <ul className="mt-1 grid gap-0.5 text-xs">
            {pick.whyComponents.map((c) => (
              <li key={c.label} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{c.label}</span>
                <span className="font-semibold">{c.points > 0 ? "+" : ""}{c.points} pts</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {full && pick.disagreement && (
        <div className="rounded border border-caution/40 bg-caution-soft p-2 text-xs">
          <p className="font-semibold tracking-wide uppercase">Model-market disagreement</p>
          <p className="mt-0.5 text-muted-foreground">
            Lock Lab {pct(pick.disagreement.model)} · market implied {pct(pick.disagreement.market)} · difference{" "}
            {((pick.disagreement.model - pick.disagreement.market) * 100).toFixed(1)} pts —{" "}
            {pick.disagreement.verdict === "supported"
              ? "supported by the stress test."
              : pick.disagreement.verdict === "weakened"
                ? "weakened by the stress test."
                : "highly uncertain under stress."}
          </p>
        </div>
      )}
    </div>
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
  status?: "pregame" | "locked" | "historical" | "unavailable";
  /** Whether the live feed returned any prop that passed verification. */
  propsVerified?: boolean;
}) {
  const live = hasLiveOdds(analysis.odds_snapshot) && !game.is_demo;
  const tailable = status === "pregame";
  const touchdownPicks = (analysis.player_props ?? []).filter(isTouchdownPick);
  const standardProps = (analysis.player_props ?? []).filter((p) => !isTouchdownPick(p));

  const tailTarget = (
    pickKey: string,
    pickLabel: string,
    pickOdds: string | null,
    pickSection: TailTarget["pickSection"],
  ): TailTarget => ({
    gameId: game.id,
    analysisId: analysis.id,
    simulationId: analysis.simulation_id ?? null,
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
            every pick below shows the exact sportsbook, line and price it was graded from
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

      <Section step={1} title="Top 2 bets" subtitle="The two strongest distinct prices on the live board.">
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
        {analysis.candidate_audit != null &&
          (analysis.candidate_audit.alternateMarketsReceived ?? 0) === 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              ALTERNATE LINES UNAVAILABLE — cannot line-shop this game.
            </p>
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
              <SimBreakdown pick={pick} full />
              {pick.standardLabel && (
                <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="eyebrow">Standard line</span>
                  <p className="mt-1 text-sm font-semibold">{pick.standardLabel}</p>
                  {pick.standardComparison && (
                    <>
                      <span className="eyebrow mt-2 block">Why this number</span>
                      <p className="mt-1 text-xs text-muted-foreground">{pick.standardComparison}</p>
                    </>
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

      <Section step={2} title="Player props" subtitle="Model-supported props with a verified live price.">
        {standardProps.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {standardProps.map((prop) => (
              <article key={prop.key} className="rounded-lg border border-hairline bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">{prop.market}</span>
                  <BadgePill badge={prop.badge} />
                </div>
                <p className="mt-2 font-display text-lg font-semibold">{prop.label}</p>
                <p className="mt-2 text-sm text-muted-foreground">{prop.reason}</p>
                <SimBreakdown pick={prop} />
                <p className="mt-3 text-xs text-muted-foreground">
                  Logged {prop.point != null ? `${prop.point} ` : ""}{prop.odds ?? "—"}
                  {prop.book ? ` · ${prop.book}` : ""}
                  {prop.capturedAt ? ` · ${formatCapturedAt(prop.capturedAt)}` : ""}
                </p>
                {tailable && (
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => onTail(tailTarget(prop.key, prop.label, prop.odds ?? null, "player_props"))}>
                    Tail
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : propsVerified ? (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            No verified player prop cleared the model's value threshold on this live board.
          </p>
        ) : (
          <div className="rounded-lg border border-stop/40 bg-stop/10 p-4">
            <p className="font-display text-sm font-bold tracking-wide text-stop uppercase">No verified player props available</p>
            <p className="mt-1 text-sm text-muted-foreground">The sportsbook feed returned no player prop that could be matched to this exact game and snapshot.</p>
          </div>
        )}
      </Section>

      <Section
        step={3}
        title="TD scorers"
        subtitle="The fun-bet board: one anytime and one first touchdown scorer per team, from verified posted prices."
      >
        {touchdownPicks.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {touchdownPicks.map((pick) => (
              <article key={pick.key} className="rounded-lg border border-hairline bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="eyebrow">
                    {pick.team ? `${pick.team} · ` : ""}
                    {pick.market}
                  </span>
                  {pick.market !== "First TD scorer" && <BadgePill badge={pick.badge} />}
                </div>
                <p className="mt-2 font-display text-lg font-semibold">{pick.label}</p>
                <p className="mt-2 text-sm text-muted-foreground">{pick.reason}</p>
                {pick.market !== "First TD scorer" && <SimBreakdown pick={pick} />}
                <p className="mt-3 text-xs text-muted-foreground">
                  Logged {pick.point != null ? `${pick.point} ` : ""}{pick.odds ?? "—"}
                  {pick.book ? ` · ${pick.book}` : ""}
                  {pick.capturedAt ? ` · ${formatCapturedAt(pick.capturedAt)}` : ""}
                </p>
                {tailable && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => onTail(tailTarget(pick.key, pick.label, pick.odds ?? null, "player_props"))}
                  >
                    Tail
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            No verified touchdown scorer price was posted for this game.
          </p>
        )}
      </Section>

    </div>
  );
}
