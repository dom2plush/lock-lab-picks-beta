import { formatKickoff, teamShort, type GameRow } from "@/lib/lock-lab-types";
import { cn } from "@/lib/utils";

export function GameCard({
  game,
  selected,
  onSelect,
}: {
  game: GameRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const spread = game.odds.spread;
  const total = game.odds.total;
  const favHome = spread ? spread.home < spread.away : false;
  const favTag = favHome
    ? teamShort(game.home_team, game.home_team_short)
    : teamShort(game.away_team, game.away_team_short);
  const favLine = spread ? Math.min(spread.home, spread.away) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-lg border bg-card p-4 text-left transition-all hover:border-primary/40 hover:shadow-sm",
        selected ? "border-primary ring-2 ring-primary/20" : "border-hairline",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">{game.sport}</span>
        <span className="text-xs text-muted-foreground">{formatKickoff(game.commence_time)}</span>
      </div>
      <p className="mt-2 font-display text-lg leading-tight font-semibold">
        {teamShort(game.away_team, game.away_team_short)} @{" "}
        {teamShort(game.home_team, game.home_team_short)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {game.away_team} at {game.home_team}
      </p>
      {live ? (
        <>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {favLine != null && (
              <span>
                <span className="font-semibold text-foreground">{favTag}</span> {favLine}
              </span>
            )}
            {total && (
              <span>
                Total <span className="font-semibold text-foreground">{total.points}</span>
              </span>
            )}
            <span>{game.odds.bookmaker}</span>
          </div>
          <p className="mt-1 text-[0.7rem] text-muted-foreground">
            Odds as of {formatCapturedAt(game.odds.capturedAt ?? game.odds_updated_at)}
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs font-semibold tracking-wide text-stop uppercase">
          Live odds unavailable
        </p>
      )}
    </button>
  );
}
