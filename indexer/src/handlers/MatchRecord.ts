/**
 * MatchRecord event handlers.
 *
 * Two events, one tx per match (see contracts/contracts/MatchRecord.sol):
 *   - MatchRegistered -- the header, once per match.
 *   - PlayerScored    -- one per racer, in standings order.
 *
 * Both rows key off the sequential `matchId`; the Player id adds `logIndex`
 * because a single tx emits many PlayerScored events.
 *
 * Numbers are normalized with BigInt()/Number() so the handler matches the
 * schema no matter how Envio types the ABI params (small uints may arrive as
 * numbers or bigints): the schema is the contract, so coerce at the boundary.
 */
import { indexer } from "envio";

indexer.onEvent(
  {
    contract: "MatchRecord",
    event: "MatchRegistered",
    fields: { transaction: ["hash"] },
  },
  ({ event, context }) => {
    context.Match.set({
      id: event.params.matchId.toString(),
      matchId: BigInt(event.params.matchId),
      courseId: event.params.courseId,
      mode: Number(event.params.mode),
      winner: event.params.winner,
      endedAt: BigInt(event.params.endedAt),
      playerCount: Number(event.params.playerCount),
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    });
  },
);

indexer.onEvent(
  { contract: "MatchRecord", event: "PlayerScored" },
  ({ event, context }) => {
    context.Player.set({
      id: `${event.params.matchId}-${event.logIndex}`,
      match_id: event.params.matchId.toString(),
      wallet: event.params.wallet,
      holdMs: BigInt(event.params.holdMs),
      finishMs: BigInt(event.params.finishMs),
      coresFound: Number(event.params.coresFound),
    });
  },
);
