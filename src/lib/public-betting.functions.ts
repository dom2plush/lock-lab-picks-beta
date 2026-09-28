import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { PublicBetting } from "./lock-lab-types";

/**
 * Automatically retrieved public-betting splits (read-only). Percentages describe the home side
 * (spread, moneyline) and the over (total). Every field may be left blank, and
 * a blank field is ignored by the model rather than guessed at.
 */
export const getPublicBetting = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ gameId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ input: PublicBetting | null }> => {
    const { readPublicBetting } = await import("./public-betting.server");
    return { input: await readPublicBetting(data.gameId) };
  });

