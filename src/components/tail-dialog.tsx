import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
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
  pickKey: string;
  pickLabel: string;
  pickOdds: string | null;
  pickSection: "top_bets" | "fun_bets" | "player_props";
};

export function TailDialog({
  target,
  onClose,
}: {
  target: TailTarget | null;
  onClose: () => void;
}) {
  const { user } = useSession();
  const submit = useServerFn(createTail);
  const [betType, setBetType] = useState<"straight" | "parlay">("straight");
  const [wager, setWager] = useState("");
  const [legs, setLegs] = useState<{ label: string; odds: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setBetType("straight");
    setWager("");
    setLegs([]);
    onClose();
  };

  const save = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const wagerValue = wager.trim() === "" ? null : Number.parseFloat(wager);
      await submit({
        data: {
          gameId: target.gameId,
          analysisId: target.analysisId,
          pickKey: target.pickKey,
          pickLabel: target.pickLabel,
          pickOdds: target.pickOdds,
          pickSection: target.pickSection,
          betType,
          wager: wagerValue != null && Number.isFinite(wagerValue) ? wagerValue : null,
          extraLegs:
            betType === "parlay"
              ? legs
                  .filter((leg) => leg.label.trim() !== "")
                  .map((leg) => ({ label: leg.label.trim(), odds: leg.odds.trim() || undefined }))
              : [],
        },
      });
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
            {target?.pickOdds ? ` · ${target.pickOdds}` : ""}
          </DialogDescription>
        </DialogHeader>

        {user ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {(["straight", "parlay"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  variant={betType === type ? "default" : "outline"}
                  onClick={() => setBetType(type)}
                  className="capitalize"
                >
                  {type}
                </Button>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wager">Wager (optional)</Label>
              <Input
                id="wager"
                inputMode="decimal"
                placeholder="25"
                value={wager}
                onChange={(event) => setWager(event.target.value)}
              />
            </div>

            {betType === "parlay" && (
              <div className="space-y-2">
                <Label>Your extra legs</Label>
                {legs.map((leg, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      placeholder="e.g. Ravens ML"
                      value={leg.label}
                      onChange={(event) =>
                        setLegs((prev) =>
                          prev.map((item, i) =>
                            i === index ? { ...item, label: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <Input
                      className="w-24"
                      placeholder="-110"
                      value={leg.odds}
                      onChange={(event) =>
                        setLegs((prev) =>
                          prev.map((item, i) =>
                            i === index ? { ...item, odds: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove leg"
                      onClick={() => setLegs((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                {legs.length < 8 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLegs((prev) => [...prev, { label: "", odds: "" }])}
                  >
                    <Plus className="size-4" /> Add leg
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Only the Lock Lab leg is graded for your win/loss record.
                </p>
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Confirm tail"}
              </Button>
            </DialogFooter>
          </div>
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
