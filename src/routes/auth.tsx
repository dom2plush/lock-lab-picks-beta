import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/use-session";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in or join — Lock Lab" },
      {
        name: "description",
        content:
          "Create a Lock Lab account with a public username to tail picks, track your bets and climb the leaderboard.",
      },
      { property: "og:title", content: "Sign in or join — Lock Lab" },
      {
        property: "og:description",
        content: "Join Lock Lab to tail picks and track your record.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { user } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate({ to: "/my-bets" });
  }, [user, navigate]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const handle = username.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
          toast.error("Username must be 3–20 letters, numbers or underscores");
          return;
        }
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { username: handle },
          },
        });
        if (error) throw error;
        toast.success("Account created — check your email if confirmation is required");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <span className="eyebrow">{mode === "signup" ? "Join Lock Lab" : "Welcome back"}</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">
        {mode === "signup" ? "Create your account" : "Sign in"}
      </h1>

      <form onSubmit={submit} className="mt-6 space-y-4 rounded-lg border border-hairline bg-card p-6">
        {mode === "signup" && (
          <div className="space-y-1.5">
            <Label htmlFor="username">Public username</Label>
            <Input
              id="username"
              autoComplete="username"
              placeholder="lockhunter"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Shown on the leaderboard and on your tails.
            </p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        <button
          type="button"
          className="w-full text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
        >
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </form>
    </div>
  );
}
