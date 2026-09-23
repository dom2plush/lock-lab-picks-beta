import type { GameRow, PickBet, Result } from "./lock-lab-types";

/** Settle a stored pick against a final score. */
export function gradePick(pick: PickBet | undefined, game: GameRow): Result {
  if (!pick || game.home_score == null || game.away_score == null) return "pending";
  const margin = game.home_score - game.away_score;
  const totalPoints = game.home_score + game.away_score;
  const isHome = pick.selection === game.home_team;

  if (pick.market === "Spread" || pick.market === "Alternate spread") {
    const line = pick.point ?? Number.parseFloat(pick.line ?? "0");
    const value = (isHome ? margin : -margin) + line;
    if (value === 0) return "push";
    return value > 0 ? "win" : "loss";
  }

  if (pick.market === "Total" || pick.market === "Alternate total") {
    const line = pick.point ?? Number.parseFloat(pick.line ?? "0");
    if (totalPoints === line) return "push";
    const over = pick.selection.toLowerCase() === "over";
    return (over ? totalPoints > line : totalPoints < line) ? "win" : "loss";
  }

  if (pick.market === "Moneyline") {
    if (margin === 0) return "push";
    return (isHome ? margin > 0 : margin < 0) ? "win" : "loss";
  }

  return "pending";
}
