import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { useSession } from "@/hooks/use-session";
import { createTail } from "@/lib/tails.functions";

export type TailTarget = {
  gameId: string;
  analysisId: string;
  /** The stored batch the displayed card came from, so the exact shown bet is saved. */
  simulationId: string | null;
  pickKey: string;
  pickLabel: string;
  pickOdds: string | null;
  pickSection: "top_bets" | "fun_bets" | "player_props";
};

function toWin(stake: number, odds: string | null): number | null {
  const price = odds ? Number.parseInt(odds, 10) : Number.NaN;
  if (!Number.isFinite(price) || Math.abs(price) < 100 || !(stake > 0)) return null;
  return price > 0 ? (stake * price) / 100 : (stake * 100) / Math.abs(price);
}

export function TailDialog({
  target,
  onClose,
}: {
  target: TailTarget | null;
  onClose: () => void;
}) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const submit = useServerFn(createTail);
  const [stake, setStake] = useState("");
  const [saving, setSaving] = useState(false);

  const stakeValue = Number.parseFloat(stake);
  const stakeValid = Number.isFinite(stakeValue) && stakeValue > 0 && stakeValue <= 1_000_000;
  const win = stakeValid ? toWin(stakeValue, target?.pickOdds ?? null) : null;

  const reset = () => {
    setStake("");
    onClose();
  };

  const save = async () => {
    if (!target || !stakeValid) return;
    setSaving(true);
    try {
      await submit({
        data: {
          analysisId: target.analysisId,
          simulationId: target.simulationId,
          pickKey: target.pickKey,
          stake: stakeValue,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["my-bets"] });
      toast.success("Tailed — tracking in My Bets");
      reset();
    } catch (error) {
      toast.error((error as Error).message || "Could not save that tail");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target != null} onOpenChange={(open) => (open ? null : reset())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Tail this pick</DialogTitle>
          <DialogDescription>
            {target?.pickLabel}
            {target?.pickOdds && !target.pickLabel.includes(target.pickOdds)
              ? ` · ${target.pickOdds}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {user ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="stake">Stake ($)</Label>
              <Input
                id="stake"
                inputMode="decimal"
                placeholder="25"
                autoFocus
                required
                value={stake}
                onChange={(event) => setStake(event.target.value.replace(/[^0-9.]/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                {win != null
                  ? `To win $${win.toFixed(2)} at ${target?.pickOdds}.`
                  : "A stake is required to tail."}
              </p>
            </div>

            <p className="flex items-start gap-2 rounded-md bg-surface p-3 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              The exact line, odds, sportsbook and time from this Lock Lab pick are locked in when you
              confirm and never change afterwards. Build parlays from your tails in My Bets.
            </p>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !stakeValid}>
                {saving ? "Saving…" : "Confirm tail"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in to track your tails, records and leaderboard spot.
            </p>
            <DialogFooter>
              <Button asChild onClick={reset}>
                <Link to="/auth">Sign in</Link>
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
