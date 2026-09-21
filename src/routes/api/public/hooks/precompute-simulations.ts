import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/** Scheduled backend pass that keeps the stored 50-run batches warm. */
export const Route = createFileRoute("/api/public/hooks/precompute-simulations")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await authenticateCronRequest(request);
        if (unauthorized) return unauthorized;

        let sport: "NFL" | "CFB" | null = null;
        let limit = 12;
        try {
          const body = (await request.json()) as { sport?: string; limit?: number };
          if (body?.sport === "NFL" || body?.sport === "CFB") sport = body.sport;
          if (typeof body?.limit === "number") limit = Math.max(1, Math.min(40, body.limit));
        } catch {
          // no body: run across both sports with the default cap
        }

        try {
          const { precomputeUpcoming } = await import("@/lib/simulation-runner.server");
          const report = await precomputeUpcoming(sport, limit);
          return Response.json({ ok: true, ...report });
        } catch (error) {
          console.error("simulation precompute failed", error);
          return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
        }
      },
    },
  },
});
