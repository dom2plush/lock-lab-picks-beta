import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

export const Route = createFileRoute("/api/public/hooks/refresh-sports-data")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await authenticateCronRequest(request);
        if (unauthorized) return unauthorized;

        const { syncSportsData } = await import("@/lib/ingest.server");
        try {
          const report = await syncSportsData();
          return Response.json({ ok: true, ...report });
        } catch (error) {
          console.error("sports data sync failed", error);
          return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
        }
      },
    },
  },
});
