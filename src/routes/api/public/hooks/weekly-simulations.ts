/**
 * Weekly simulation cycle.
 *
 * NFL runs Tuesday, CFB runs Sunday and Monday. For every upcoming pregame
 * game of that sport this refreshes the live odds board, then builds the
 * 50-simulation batch once per input state. Games whose inputs already have a
 * stored batch are skipped, so the model is never called twice for the same
 * board and credits are only spent on genuinely new or changed games.
 */
import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import type { GameRow, Sport } from "@/lib/lock-lab-types";

/** Hard bound on the work a single run may do. */
const MAX_GAMES_PER_RUN = 40;
/** Only games kicking off inside this window are simulated. */
const WINDOW_DAYS = 9;

export const Route = createFileRoute("/api/public/hooks/weekly-simulations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await authenticateCronRequest(request);
        if (unauthorized && !(await hasScheduleToken(request))) return unauthorized;


        let sport: Sport | null = null;
        try {
          const body = (await request.json()) as { sport?: string };
          if (body?.sport === "NFL" || body?.sport === "CFB") sport = body.sport;
        } catch {
          // no body: run both sports
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { ensureSimulationBatch } = await import("@/lib/simulation-runner.server");
        const { refreshGameOdds, hasProviderKey } = await import("@/lib/ingest.server");

        if (!hasProviderKey()) {
          return Response.json(
            { ok: false, error: "LIVE ODDS UNAVAILABLE — no odds provider is connected." },
            { status: 503 },
          );
        }

        const now = new Date();
        const until = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
        let query = supabaseAdmin
          .from("games")
          .select("*")
          .eq("status", "scheduled")
          .eq("is_demo", false)
          .gt("commence_time", now.toISOString())
          .lt("commence_time", until.toISOString())
          .order("commence_time", { ascending: true })
          .limit(MAX_GAMES_PER_RUN);
        if (sport) query = query.eq("sport", sport);

        const { data, error } = await query;
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const games = (data ?? []) as unknown as GameRow[];
        const report = { created: 0, skipped: 0, noOdds: 0, failed: 0, considered: games.length };

        for (const game of games) {
          try {
            const refreshed = await refreshGameOdds(game);
            const outcome = await ensureSimulationBatch(refreshed ?? game);
            if (outcome === "created") report.created += 1;
            else if (outcome === "skipped") report.skipped += 1;
            else report.noOdds += 1;
          } catch (err) {
            report.failed += 1;
            console.error("[sim] weekly batch failed", game.id, (err as Error).message);
          }
        }

        return Response.json({ ok: true, sport: sport ?? "ALL", ...report });
      },
    },
  },
});
