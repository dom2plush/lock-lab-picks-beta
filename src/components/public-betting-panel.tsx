import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/hooks/use-session";
import {
  clearPublicBetting,
  getPublicBetting,
  savePublicBetting,
} from "@/lib/public-betting.functions";
import { formatCapturedAt, teamShort, type GameRow } from "@/lib/lock-lab-types";

type FieldKey =
  | "spreadBetPct"
  | "spreadMoneyPct"
  | "mlBetPct"
  | "mlMoneyPct"
  | "totalBetPct"
  | "totalMoneyPct";

const EMPTY: Record<FieldKey, string> = {
  spreadBetPct: "",
  spreadMoneyPct: "",
  mlBetPct: "",
  mlMoneyPct: "",
  totalBetPct: "",
  totalMoneyPct: "",
};

/**
 * Optional public-betting splits, typed in by hand. Percentages are for the
 * home side (spread, moneyline) and the over (total). Anything left blank is
 * ignored by the model — nothing is guessed.
 */
export function PublicBettingPanel({ game }: { game: GameRow }) {
  const { user } = useSession();
  const load = useServerFn(getPublicBetting);
  const save = useServerFn(savePublicBetting);
  const clear = useServerFn(clearPublicBetting);
  const [values, setValues] = useState<Record<FieldKey, string>>(EMPTY);
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const stored = useQuery({
    queryKey: ["public-betting", game.id],
    queryFn: () => load({ data: { gameId: game.id } }),
  });

  useEffect(() => {
    const input = stored.data?.input;
    if (!input) {
      setValues(EMPTY);
      setRecordedAt(null);
      return;
    }
    const text = (v: number | null | undefined) => (typeof v === "number" ? String(v) : "");
    setValues({
      spreadBetPct: text(input.spreadBetPct),
      spreadMoneyPct: text(input.spreadMoneyPct),
      mlBetPct: text(input.mlBetPct),
      mlMoneyPct: text(input.mlMoneyPct),
      totalBetPct: text(input.totalBetPct),
      totalMoneyPct: text(input.totalMoneyPct),
    });
    setRecordedAt(input.recordedAt ?? input.updatedAt ?? null);
  }, [stored.data]);

  const home = teamShort(game.home_team, game.home_team_short);

  const number = (key: FieldKey) => {
    const raw = values[key].trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Enter each share between 0 and 100");
    return n;
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const result = await save({
        data: {
          gameId: game.id,
          spreadBetPct: number("spreadBetPct"),
          spreadMoneyPct: number("spreadMoneyPct"),
          mlBetPct: number("mlBetPct"),
          mlMoneyPct: number("mlMoneyPct"),
          totalBetPct: number("totalBetPct"),
          totalMoneyPct: number("totalMoneyPct"),
          recordedAt: new Date().toISOString(),
        },
      });
      setRecordedAt(result.input?.recordedAt ?? null);
      await stored.refetch();
      toast.success("Saved — run Analyze again to use it");
    } catch (error) {
      toast.error((error as Error).message || "Could not save those numbers");
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    setSaving(true);
    try {
      await clear({ data: { gameId: game.id } });
      setValues(EMPTY);
      setRecordedAt(null);
      await stored.refetch();
      toast.success("Cleared");
    } catch (error) {
      toast.error((error as Error).message || "Could not clear those numbers");
    } finally {
      setSaving(false);
    }
  };

  const field = (key: FieldKey, label: string) => (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        inputMode="decimal"
        placeholder="—"
        value={values[key]}
        disabled={!user || saving}
        onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
        className="mt-1"
      />
    </label>
  );

  return (
    <section className="rounded-lg border border-hairline bg-card p-5">
      <span className="eyebrow">Optional · public betting</span>
      <h3 className="mt-1 font-display text-lg font-semibold">Ticket and money splits</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the share on <span className="font-semibold text-foreground">{home}</span> for the
        spread and moneyline, and the share on the <span className="font-semibold text-foreground">over</span> for
        the total. Leave anything blank and it is ignored — it only breaks ties between two very
        close bets.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {field("spreadBetPct", `Spread bet % (${home})`)}
        {field("mlBetPct", `Moneyline bet % (${home})`)}
        {field("totalBetPct", "Total bet % (over)")}
        {field("spreadMoneyPct", `Spread money % (${home})`)}
        {field("mlMoneyPct", `Moneyline money % (${home})`)}
        {field("totalMoneyPct", "Total money % (over)")}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={onSave} disabled={!user || saving}>
          Save numbers
        </Button>
        <Button size="sm" variant="outline" onClick={onClear} disabled={!user || saving}>
          Clear
        </Button>
        {recordedAt && (
          <span className="text-xs text-muted-foreground">
            Entered {formatCapturedAt(recordedAt)}
          </span>
        )}
        {!user && (
          <span className="text-xs text-muted-foreground">Sign in to enter these numbers.</span>
        )}
      </div>
    </section>
  );
}
