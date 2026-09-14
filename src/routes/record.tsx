import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/record")({
  head: () => ({
    meta: [
      { title: "Lock Lab Record — NFL, CFB and Overall" },
      {
        name: "description",
        content:
          "The running Lock Lab record on #1 picks: NFL, college football and overall wins, losses and pushes.",
      },
      { property: "og:title", content: "Lock Lab Record — NFL, CFB and Overall" },
      {
        property: "og:description",
        content: "Wins, losses and pushes on every Lock Lab #1 pick, by sport and overall.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RecordPage,
});

type RecordRow = {
  sport: string;
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
};

function RecordCard({ title, row }: { title: string; row: RecordRow }) {
  const decided = row.wins + row.losses;
  return (
    <div className="rounded-lg border border-hairline bg-card p-6">
      <span className="eyebrow">{title}</span>
      <p className="mt-2 font-display text-5xl leading-none font-semibold">
        {row.wins}
        <span className="text-muted-foreground">–</span>
        {row.losses}
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        {row.pushes} push{row.pushes === 1 ? "" : "es"} · {row.pending} still open
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {decided} graded #1 pick{decided === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function RecordPage() {
  const query = useQuery({
    queryKey: ["records"],
    queryFn: async () => {
      const { data, error } = await supabase.from("lock_lab_records").select("*");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as RecordRow[];
    },
  });

  const rows = query.data ?? [];
  const bySport = (sport: string): RecordRow =>
    rows.find((row) => row.sport === sport) ?? { sport, wins: 0, losses: 0, pushes: 0, pending: 0 };
  const overall = rows.reduce<RecordRow>(
    (acc, row) => ({
      sport: "Overall",
      wins: acc.wins + Number(row.wins),
      losses: acc.losses + Number(row.losses),
      pushes: acc.pushes + Number(row.pushes),
      pending: acc.pending + Number(row.pending),
    }),
    { sport: "Overall", wins: 0, losses: 0, pushes: 0, pending: 0 },
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <span className="eyebrow">Accountability</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">The record</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Every Lock Lab #1 pick is graded against the final score. Nothing is removed after the fact.
      </p>

      {query.isLoading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <RecordCard title="NFL" row={bySport("NFL")} />
          <RecordCard title="College football" row={bySport("CFB")} />
          <RecordCard title="Overall" row={overall} />
        </div>
      )}
    </div>
  );
}
