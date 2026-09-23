import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import type { GameRow } from "./lock-lab-types";

const Input = z.object({ sport: z.enum(["NFL", "CFB"]) });

/**
 * Public read of upcoming games for the Analyze board.
 *
 * Runs server-side so the production browser bundle never needs Supabase
 * configuration — the server reads its own env. The games table has a
 * narrow public SELECT policy, so the publishable key is sufficient.
 */
export const getUpcomingGames = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }): Promise<{ games: GameRow[] }> => {
    const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
    const key =
      process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) {
      throw new Error("Supabase is not configured on the server; cannot load the games board.");
    }
    const supabasePublic = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
            headers.delete("Authorization");
          }
          headers.set("apikey", key);
          return fetch(input, { ...init, headers });
        },
      },
    });

    const { data: rows, error } = await supabasePublic
      .from("games")
      .select("*")
      .eq("sport", data.sport)
      .neq("status", "final")
      .gte("commence_time", new Date().toISOString())
      .order("commence_time", { ascending: true })
      .limit(300);
    if (error) throw new Error(error.message);
    return { games: (rows ?? []) as unknown as GameRow[] };
  });
