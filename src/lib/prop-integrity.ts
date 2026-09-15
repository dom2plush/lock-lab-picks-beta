/**
 * Market-offer integrity checks.
 *
 * Nothing here scores a bet — it only answers one question: can this posted
 * offer be proven to belong to the exact game and odds snapshot the user is
 * looking at? Anything that cannot be proven is rejected with a reason, never
 * repaired and never replaced with a generated stand-in.
 */
import type { GameRow, MarketOffer } from "./lock-lab-types";

/** Player-prop markets Lock Lab is allowed to analyse. */
export const VERIFIED_PROP_MARKETS = [
  "player_pass_yds",
  "player_pass_tds",
  "player_rush_yds",
  "player_reception_yds",
  "player_receptions",
  "player_anytime_td",
] as const;

const PROP_SIDES = ["over", "under", "yes", "no"];

export type OfferRejection = {
  market: string;
  selection: string;
  player?: string;
  reason: string;
};

export type OfferVerification = {
  verified: MarketOffer[];
  rejected: OfferRejection[];
};

function baseProblems(
  offer: MarketOffer,
  game: GameRow,
  requireSnapshotBook: boolean,
): string[] {
  const problems: string[] = [];

  // Event scoping: the provider returns derivative markets per event. An offer
  // tagged with a different event id did not come from this game.
  if (offer.eventId && offer.eventId !== game.provider_game_id) {
    problems.push("offer belongs to a different game");
  }
  if (!offer.book) problems.push("no sportsbook recorded");
  if (!offer.capturedAt || Number.isNaN(new Date(offer.capturedAt).getTime())) {
    problems.push("no valid capture timestamp");
  }
  if (typeof offer.price !== "number" || !Number.isFinite(offer.price)) {
    problems.push("no usable price");
  }

  // Player props must belong to the sportsbook named on the snapshot. Game-line
  // alternates are frequently posted by a different book than the one pricing
  // the main line; those stay eligible because every pick carries and displays
  // its own book, line, price and capture time.
  const snapshotBookKey = game.odds?.bookmakerKey;
  if (requireSnapshotBook && snapshotBookKey && offer.bookKey && offer.bookKey !== snapshotBookKey) {
    problems.push("sportsbook differs from the displayed snapshot");
  }

  return problems;
}

/** Player props: must name a player, a supported market and a real side. */
export function verifyPropOffers(offers: MarketOffer[], game: GameRow): OfferVerification {
  const verified: MarketOffer[] = [];
  const rejected: OfferRejection[] = [];
  const seen = new Set<string>();

  for (const offer of offers) {
    const problems = baseProblems(offer, game, true);

    if (!(VERIFIED_PROP_MARKETS as readonly string[]).includes(offer.market)) {
      problems.push("market is not a verified player-prop market");
    }
    const player = (offer.player ?? "").trim();
    if (!player) problems.push("no player named on the offer");
    if (!PROP_SIDES.includes((offer.selection ?? "").trim().toLowerCase())) {
      problems.push("selection is not a real posted side");
    }

    const id = `${offer.market}:${player.toLowerCase()}:${(offer.selection ?? "").toLowerCase()}:${offer.point ?? "-"}`;
    if (!problems.length && seen.has(id)) problems.push("duplicate offer");

    if (problems.length) {
      rejected.push({
        market: offer.market,
        selection: offer.selection,
        ...(offer.player ? { player: offer.player } : {}),
        reason: problems.join("; "),
      });
      continue;
    }
    seen.add(id);
    verified.push(offer);
  }

  return { verified, rejected };
}

/** Alternate lines and team totals: game-level markets, no player attached. */
export function verifyAlternateOffers(offers: MarketOffer[], game: GameRow): OfferVerification {
  const verified: MarketOffer[] = [];
  const rejected: OfferRejection[] = [];

  for (const offer of offers) {
    const problems = baseProblems(offer, game, false);
    if (offer.market.startsWith("player_")) problems.push("player market in the game-line feed");
    if (offer.point == null) problems.push("no line recorded");

    const selection = (offer.selection ?? "").trim();
    const isTotalSide = ["over", "under"].includes(selection.toLowerCase());
    const isTeam = selection === game.home_team || selection === game.away_team;
    if (!isTotalSide && !isTeam) {
      problems.push("selection does not match either team in this game");
    }

    if (problems.length) {
      rejected.push({ market: offer.market, selection: offer.selection, reason: problems.join("; ") });
      continue;
    }
    verified.push(offer);
  }

  return { verified, rejected };
}
