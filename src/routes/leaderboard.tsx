import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — Lock Lab Community" },
      {
        name: "description",
        content:
          "The top Lock Lab tailers: who is riding the picks, their record on tailed legs and their following.",
      },
      { property: "og:title", content: "Leaderboard — Lock Lab Community" },
      {
        property: "og:description",
        content: "Top community tailers ranked by their record on Lock Lab legs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LeaderboardPage,
});

type LeaderRow = {
  id: string;
  username: string;
  display_name: string | null;
  tails: number;
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  followers: number;
};

function LeaderboardPage() {
  const query = useQuery({
    queryKey: ["leaderboard"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leaderboard")
        .select("*")
        .order("wins", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as LeaderRow[];
    },
  });

  const rows = query.data ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <span className="eyebrow">Community</span>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight">Leaderboard</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Ranked on the Lock Lab leg of each tail — the only leg we grade.
      </p>

      {query.isLoading ? (
        <Skeleton className="mt-6 h-64 rounded-lg" />
      ) : rows.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-hairline bg-card p-4 text-sm text-muted-foreground">
          No tails yet — be the first on the board.
        </p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-hairline bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Member</TableHead>
                <TableHead className="text-right">Tails</TableHead>
                <TableHead className="text-right">Record</TableHead>
                <TableHead className="text-right">Followers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <span className="font-semibold">@{row.username}</span>
                    {row.display_name && (
                      <span className="ml-2 text-xs text-muted-foreground">{row.display_name}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{row.tails}</TableCell>
                  <TableCell className="text-right font-display font-semibold">
                    {row.wins}–{row.losses}
                    {Number(row.pushes) > 0 && (
                      <span className="text-muted-foreground">–{row.pushes}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{row.followers}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
