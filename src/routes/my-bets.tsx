import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Layers, Lock, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/hooks/use-session";
import type { Result } from "@/lib/lock-lab-types";
import { formatKickoff } from "@/lib/lock-lab-types";
import {
  createParlay,
  deleteParlay,
  deleteTail,
  getMyBets,
  type MyParlay,
  type MyTail,
  type RecordLine,
} from "@/lib/tails.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/my-bets")({
  head: () => ({
    meta: [
      { title: "My Bets — Lock Lab" },
      {
        name: "description",
        content:
          "Your tailed Lock Lab picks and parlays with locked lines and odds, live and upcoming bets, past results, units and ROI.",
      },
      { property: "og:title", content: "My Bets — Lock Lab" },
      {
        property: "og:description",
        content: "Track tailed Lock Lab singles and parlays: record, units, ROI and results.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MyBetsPage,
});

const RESULT_STYLE: Record<Result, string> = {
  win: "bg-go-soft text-go",
  loss: "bg-stop-soft text-stop",
  push: "bg-surface text-muted-foreground",
  pending: "bg-caution-soft text-caution",
};

type Phase = "live" | "upcoming" | "past";
type Game = MyTail["games"];

const started = (g: Game, now: number) =>
  g.status !== "scheduled" || new Date(g.commence_time).getTime() <= now;

function tailPhase(t: MyTail, now: number): Phase {
  if (t.lock_leg_result !== "pending" || t.games.status === "final") return "past";
  return started(t.games, now) ? "live" : "upcoming";
}

function parlayPhase(p: MyParlay, now: number): Phase {
  if (p.result !== "pending" || p.parlay_legs.every((l) => l.games.status === "final")) return "past";
  return p.parlay_legs.some((l) => started(l.games, now)) ? "live" : "upcoming";
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const fmtOdds = (n: number) => (n > 0 ? `+${n}` : String(n));
const decimal = (price: number) => (price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price));

function RecordCard({ title, line }: { title: string; line: RecordLine }) {
  const units = Number(line.units);
  return (
    <div className="rounded-lg border border-hairline bg-card p-4">
      <span className="eyebrow">{title}</span>
      <p className="mt-1 font-display text-3xl font-semibold">
        {line.wins}–{line.losses}
        {line.pushes > 0 && <span className="text-muted-foreground">–{line.pushes}</span>}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Win %</dt>
          <dd className="font-semibold">{line.winPct != null ? `${line.winPct}%` : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Units</dt>
          <dd className={cn("font-semibold", units > 0 && "text-go", units < 0 && "text-stop")}>
            {units > 0 ? "+" : ""}
            {units.toFixed(2)}u
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">ROI</dt>
          <dd className="font-semibold">{line.roi != null ? `${line.roi}%` : "—"}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {Number(line.staked) > 0 ? `${money(Number(line.profit))} on ${money(Number(line.staked))} settled · ` : ""}
        {line.pending} open
      </p>
    </div>
  );
}

function ResultPill({ result, label }: { result: Result; label?: string | undefined }) {
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase", RESULT_STYLE[result])}>
      {label ?? result}
    </span>
  );
}

function lockedLine(book: string | null, capturedAt: string | null) {
  const parts = [book, capturedAt ? `captured ${formatKickoff(capturedAt)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function SingleCard({ tail, phase, onDelete }: { tail: MyTail; phase: Phase; onDelete?: (() => void) | undefined }) {
  const g = tail.games;
  const awaiting = phase === "past" && tail.lock_leg_result === "pending";
  const stake = Number(tail.wager ?? 0);
  const payout =
    tail.lock_leg_result === "win" && tail.price != null ? stake * decimal(tail.price) : null;
  return (
    <article className="rounded-lg border border-hairline bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="eyebrow">
            Single · {g.sport} · {g.away_team} at {g.home_team}
          </span>
          <p className="mt-1 font-display text-lg font-semibold">
            {tail.pick_label}
            {tail.pick_odds && !tail.pick_label.includes(tail.pick_odds) ? ` (${tail.pick_odds})` : ""}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            <Lock className="size-3" />
            {lockedLine(tail.odds_book, tail.odds_captured_at) ?? "Locked Lock Lab line"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stake > 0 ? `Stake ${money(stake)}` : "No stake"}
            {payout != null ? ` · paid ${money(payout)}` : ""} · kickoff {formatKickoff(g.commence_time)}
            {g.home_score != null && g.away_score != null ? ` · final ${g.away_score}–${g.home_score}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {phase === "live" && tail.lock_leg_result === "pending" ? (
            <ResultPill result="pending" label="Live" />
          ) : (
            <ResultPill result={tail.lock_leg_result} label={awaiting ? "Awaiting grade" : undefined} />
          )}
          {onDelete && (
            <Button variant="ghost" size="icon" aria-label="Remove bet" onClick={onDelete}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {awaiting && (
        <p className="mt-2 text-xs text-muted-foreground">
          Player and touchdown bets need a player stats feed to grade, which isn't connected yet, so this
          one doesn't count toward your record until it's graded.
        </p>
      )}
    </article>
  );
}

function ParlayCard({ parlay, phase, onDelete }: { parlay: MyParlay; phase: Phase; onDelete?: (() => void) | undefined }) {
  const odds = parlay.actual_odds ?? parlay.computed_odds;
  const toReturn = parlay.actual_payout ?? Number(parlay.stake) * decimal(odds);
  return (
    <article className="rounded-lg border border-hairline bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="eyebrow">Parlay · {parlay.leg_count} legs</span>
          <p className="mt-1 font-display text-lg font-semibold">
            {fmtOdds(odds)}
            {parlay.actual_odds != null && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                legs price out at {fmtOdds(parlay.computed_odds)}
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Stake {money(Number(parlay.stake))} ·{" "}
            {parlay.result === "pending"
              ? `to return ${money(toReturn)}`
              : `returned ${money(Number(parlay.settled_payout ?? 0))}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {phase === "live" && parlay.result === "pending" ? (
            <ResultPill result="pending" label="Live" />
          ) : (
            <ResultPill
              result={parlay.result}
              label={phase === "past" && parlay.result === "pending" ? "Awaiting grade" : undefined}
            />
          )}
          {onDelete && (
            <Button variant="ghost" size="icon" aria-label="Remove parlay" onClick={onDelete}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {parlay.parlay_legs.map((leg) => (
          <li key={leg.id} className="rounded-md bg-surface px-3 py-2 text-xs">
            <span className="font-semibold">
              {leg.pick_label}
              {leg.pick_odds && !leg.pick_label.includes(leg.pick_odds) ? ` (${leg.pick_odds})` : ""}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {leg.games.away_team} at {leg.games.home_team}
              {leg.odds_book ? ` · ${leg.odds_book}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ParlayBuilder({
  open,
  onOpenChange,
  eligible,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eligible: MyTail[];
}) {
  const queryClient = useQueryClient();
  const submit = useServerFn(createParlay);
  const [selected, setSelected] = useState<string[]>([]);
  const [stake, setStake] = useState("");
  const [actualOdds, setActualOdds] = useState("");
  const [actualPayout, setActualPayout] = useState("");
  const [saving, setSaving] = useState(false);

  const legs = eligible.filter((t) => selected.includes(t.id));
  const legDecimal = legs.reduce((acc, t) => acc * (t.price != null ? decimal(t.price) : 1), 1);
  const computed =
    legs.length >= 2 ? (legDecimal >= 2 ? Math.round((legDecimal - 1) * 100) : Math.round(-100 / (legDecimal - 1))) : null;
  const stakeValue = Number.parseFloat(stake);
  const stakeValid = Number.isFinite(stakeValue) && stakeValue > 0;
  const oddsValue = actualOdds.trim() === "" ? null : Number.parseInt(actualOdds, 10);
  const oddsValid = oddsValue == null || (Number.isFinite(oddsValue) && Math.abs(oddsValue) >= 100);
  const payoutValue = actualPayout.trim() === "" ? null : Number.parseFloat(actualPayout);
  const payoutValid = payoutValue == null || (Number.isFinite(payoutValue) && stakeValid && payoutValue > stakeValue);
  const canSave = legs.length >= 2 && legs.length <= 12 && stakeValid && oddsValid && payoutValid;

  const close = () => {
    setSelected([]);
    setStake("");
    setActualOdds("");
    setActualPayout("");
    onOpenChange(false);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await submit({
        data: {
          tailIds: legs.map((t) => t.id),
          stake: stakeValue,
          actualOdds: oddsValue,
          actualPayout: payoutValue,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["my-bets"] });
      toast.success("Parlay saved");
      close();
    } catch (error) {
      toast.error((error as Error).message || "Could not save that parlay");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Build a parlay</DialogTitle>
          <DialogDescription>
            Pick 2–12 of your tailed bets on games that haven't started. Each leg keeps its locked line and odds.
          </DialogDescription>
        </DialogHeader>

        {eligible.length < 2 ? (
          <p className="rounded-md border border-dashed border-hairline p-4 text-sm text-muted-foreground">
            You need at least 2 tailed bets on games that haven't started. Tail more Lock Lab picks first.
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <ul className="space-y-2">
              {eligible.map((t) => {
                const checked = selected.includes(t.id);
                return (
                  <li key={t.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-md border border-hairline p-3 text-sm",
                        checked && "border-primary bg-surface",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) =>
                          setSelected((prev) =>
                            value ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                          )
                        }
                        aria-label={t.pick_label}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold">{t.pick_label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t.games.away_team} at {t.games.home_team} · {formatKickoff(t.games.commence_time)}
                          {t.odds_book ? ` · ${t.odds_book}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="parlay-stake">Stake ($)</Label>
                <Input
                  id="parlay-stake"
                  inputMode="decimal"
                  placeholder="10"
                  required
                  value={stake}
                  onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="parlay-odds">Actual odds</Label>
                <Input
                  id="parlay-odds"
                  inputMode="numeric"
                  placeholder={computed != null ? fmtOdds(computed) : "+450"}
                  value={actualOdds}
                  onChange={(e) => setActualOdds(e.target.value.replace(/[^0-9+-]/g, ""))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="parlay-payout">Actual payout ($)</Label>
                <Input
                  id="parlay-payout"
                  inputMode="decimal"
                  placeholder="Optional"
                  value={actualPayout}
                  onChange={(e) => setActualPayout(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {computed != null
                ? `Your ${legs.length} legs price out at ${fmtOdds(computed)}${stakeValid ? ` (returns ${money(stakeValue * legDecimal)})` : ""}. `
                : "Select at least 2 legs. "}
              Enter your sportsbook's actual parlay odds or total payout if they differ.
              {!oddsValid && " Odds must look like +450 or -120."}
              {!payoutValid && " Payout must be more than the stake."}
            </p>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !canSave}>
                {saving ? "Saving…" : "Save parlay"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MyBetsPage() {
  const { user, loading } = useSession();
  const queryClient = useQueryClient();
  const fetchBets = useServerFn(getMyBets);
  const removeTail = useServerFn(deleteTail);
  const removeParlay = useServerFn(deleteParlay);
  const [builderOpen, setBuilderOpen] = useState(false);

  const query = useQuery({
    queryKey: ["my-bets", user?.id],
    enabled: Boolean(user),
    queryFn: () => fetchBets(),
    refetchInterval: 60_000,
  });

  const now = Date.now();
  const data = query.data;
  const groups = useMemo(() => {
    const out: Record<Phase, { tails: MyTail[]; parlays: MyParlay[] }> = {
      live: { tails: [], parlays: [] },
      upcoming: { tails: [], parlays: [] },
      past: { tails: [], parlays: [] },
    };
    for (const t of data?.tails ?? []) out[tailPhase(t, now)].tails.push(t);
    for (const p of data?.parlays ?? []) out[parlayPhase(p, now)].parlays.push(p);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const inParlay = new Set((data?.parlays ?? []).flatMap((p) => p.parlay_legs.map((l) => l.tail_id)));
  const eligible = groups.upcoming.tails.filter((t) => t.price != null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["my-bets"] });
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  if (!loading && !user) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="font-display text-3xl font-semibold">My Bets</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to see the picks you've tailed and how they're running.
        </p>
        <Button asChild className="mt-6">
          <Link to="/auth">Sign in</Link>
        </Button>
      </div>
    );
  }

  const isLoading = loading || query.isLoading;
  const section = (title: string, phase: Phase, empty: string) => {
    const g = groups[phase];
    return (
      <section className="space-y-3">
        <h2 className="eyebrow">
          {title} ({g.tails.length + g.parlays.length})
        </h2>
        {g.parlays.map((p) => (
          <ParlayCard
            key={p.id}
            parlay={p}
            phase={phase}
            onDelete={phase === "upcoming" ? () => run(() => removeParlay({ data: { id: p.id } })) : undefined}
          />
        ))}
        {g.tails.map((t) => (
          <SingleCard
            key={t.id}
            tail={t}
            phase={phase}
            onDelete={
              phase === "upcoming" && !inParlay.has(t.id)
                ? () => run(() => removeTail({ data: { id: t.id } }))
                : undefined
            }
          />
        ))}
        {!isLoading && g.tails.length + g.parlays.length === 0 && (
          <p className="rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
            {empty}
          </p>
        )}
      </section>
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="eyebrow">Your slips</span>
          <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">My bets</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Your official record counts only Lock Lab picks you tailed, at the exact line and odds locked when
            you tailed them.
          </p>
        </div>
        <Button onClick={() => setBuilderOpen(true)} disabled={!user}>
          <Layers className="size-4" /> Build a parlay
        </Button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {isLoading || !data ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-lg" />)
        ) : (
          <>
            <RecordCard title="Singles" line={data.record.singles} />
            <RecordCard title="Parlays" line={data.record.parlays} />
            <RecordCard title="Combined" line={data.record.combined} />
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Units: 1 unit risked per bet at its locked price. ROI: profit ÷ total staked on settled bets.
      </p>

      {query.isError && (
        <p className="mt-6 rounded-lg border border-hairline bg-stop-soft p-4 text-sm text-stop">
          Your bets could not be loaded. Try refreshing the page.
        </p>
      )}

      <Tabs defaultValue="open" className="mt-8">
        <TabsList>
          <TabsTrigger value="open">
            Open bets ({groups.live.tails.length + groups.live.parlays.length + groups.upcoming.tails.length + groups.upcoming.parlays.length})
          </TabsTrigger>
          <TabsTrigger value="past">
            Past bets ({groups.past.tails.length + groups.past.parlays.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="open" className="mt-4 space-y-8">
          {isLoading && Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
          {section("Live", "live", "Nothing live right now.")}
          {section("Not started", "upcoming", "No upcoming bets. Run a matchup and hit Tail on a pick.")}
        </TabsContent>
        <TabsContent value="past" className="mt-4">
          {section("Completed", "past", "No completed bets yet.")}
        </TabsContent>
      </Tabs>

      <ParlayBuilder open={builderOpen} onOpenChange={setBuilderOpen} eligible={eligible} />
    </div>
  );
}
