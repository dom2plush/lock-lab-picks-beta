/**
 * Hidden calibration view. Not linked from the app; the public Lock Lab
 * interface is unchanged. Shows every candidate the engine considered with the
 * exact probability, price and expected-value numbers it used to decide.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCandidateAudits } from "@/lib/audit.functions";

export const Route = createFileRoute("/dev-audit")({
  component: DevAuditPage,
  head: () => ({
    meta: [
      { title: "Lock Lab candidate audit (internal)" },
      { name: "description", content: "Internal calibration view of every bet candidate Lock Lab considered." },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:title", content: "Lock Lab candidate audit (internal)" },
      { property: "og:description", content: "Internal calibration view of Lock Lab candidate grading." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const pct = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const signedPct = (value: number | null | undefined) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
const ev = (value: number | null | undefined) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

function DevAuditPage() {
  const fetchAudits = useServerFn(getCandidateAudits);
  const { data, isLoading, error } = useQuery({
    queryKey: ["candidate-audits"],
    queryFn: () => fetchAudits(),
  });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 font-mono text-xs">
      <h1 className="mb-1 font-sans text-xl font-bold">Candidate audit (internal)</h1>
      <p className="mb-6 text-muted-foreground">
        Every candidate considered on the most recent analyses, with the exact numbers used by the selection
        gate. Not shown anywhere in the player-facing app.
      </p>

      {isLoading && <p>Loading…</p>}
      {error && <p className="text-destructive">{(error as Error).message}</p>}

      {data?.map((game) => (
        <section key={game.gameId} className="mb-10 border border-border">
          <header className="border-b border-border bg-muted/40 p-3">
            <div className="font-sans text-sm font-semibold">
              {game.sport} · {game.matchup}
            </div>
            <div className="text-muted-foreground">
              top bets published: {game.topBetCount}
              {game.audit
                ? ` · snapshot ${game.audit.snapshotBook ?? "?"} ${game.audit.snapshotCapturedAt ?? ""} · alt offers ${game.audit.altMarketsSupplied} · prop offers ${game.audit.propMarketsSupplied}`
                : " · no audit recorded"}
            </div>
            {game.verdict && <div className="mt-1 text-muted-foreground">verdict: {game.verdict}</div>}
            {game.audit?.strongestRejected && (
              <div className="mt-1">
                strongest rejected: {game.audit.strongestRejected.label} (edge{" "}
                {signedPct(game.audit.strongestRejected.edge)}, EV {ev(game.audit.strongestRejected.ev)})
              </div>
            )}
          </header>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="bg-muted/20 text-left">
                <tr>
                  {[
                    "candidate",
                    "kind",
                    "book",
                    "line",
                    "price",
                    "est",
                    "implied",
                    "edge",
                    "EV",
                    "±",
                    "needs",
                    "score",
                    "tier",
                    "decision",
                    "alt vs std",
                    "reason",
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-border p-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(game.audit?.entries ?? []).map((e) => (
                  <tr key={e.key} className="border-b border-border/50 align-top">
                    <td className="p-2 whitespace-nowrap">{e.label}</td>
                    <td className="p-2">{e.kind}</td>
                    <td className="p-2 whitespace-nowrap">{e.book}</td>
                    <td className="p-2">{e.line ?? "—"}</td>
                    <td className="p-2">{e.price > 0 ? `+${e.price}` : e.price}</td>
                    <td className="p-2">{pct(e.estimatedProb)}</td>
                    <td className="p-2">{pct(e.impliedProb)}</td>
                    <td className="p-2">{signedPct(e.edge)}</td>
                    <td className="p-2">{ev(e.ev)}</td>
                    <td className="p-2">{signedPct(e.uncertainty)}</td>
                    <td className="p-2">{signedPct(e.requiredEdge)}</td>
                    <td className="p-2">{e.valueScore == null ? "—" : `${e.valueScore.toFixed(2)}x`}</td>
                    <td className="p-2">{e.tier}</td>
                    <td className="p-2 whitespace-nowrap">
                      {e.decision.toUpperCase()}
                      {e.section ? ` (${e.section})` : ""}
                    </td>
                    <td className="p-2">
                      {e.alternateConsidered
                        ? `${e.alternateBetterThanStandard ? "better" : "worse"} than ${e.standardLine} (${e.standardPrice})`
                        : "—"}
                    </td>
                    <td className="p-2 min-w-[18rem]">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
