// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MatchRecord
/// @notice Append-only log of finished TEKK matches, written by the game server.
///
/// One finished match becomes one transaction: a `MatchRegistered` header event
/// plus one `PlayerScored` event per racer, and the summary is also kept in
/// storage so `matches(id)` is self-serve. The contract holds no value and
/// stores no funds -- the event log *is* the record. An indexer (Envio
/// HyperIndex, Stage 2) turns the logs into leaderboard rows for the lobby.
///
/// Stage 1: racers have no on-chain identities yet, so `winner` and every
/// player `wallet` arrive as the zero address. Stage 3 (Privy) replaces that
/// with real embedded-wallet addresses without touching this contract.
contract MatchRecord {
    /// @notice The only address allowed to write records. Set once at deploy.
    address public immutable registrar;

    /// @notice Sequential id of the last registered match.
    uint256 public matchCount;

    /// @notice Game modes, mirroring the course files.
    uint8 public constant MODE_HOLD = 0;
    uint8 public constant MODE_REACH = 1;
    uint8 public constant MODE_HUNT = 2;

    struct Match {
        address winner;
        string courseId;
        uint8 mode;
        uint64 endedAt;
        uint8 playerCount;
    }

    struct PlayerResult {
        address wallet;
        uint64 holdMs;
        int64 finishMs; // -1 when the racer never finished
        uint8 coresFound;
    }

    /// @dev matchId and winner are indexed so an indexer can filter cheaply;
    /// courseId and mode stay readable in the log data.
    event MatchRegistered(
        uint256 indexed matchId,
        address indexed winner,
        string courseId,
        uint8 mode,
        uint64 endedAt,
        uint8 playerCount
    );

    event PlayerScored(
        uint256 indexed matchId,
        address indexed wallet,
        uint64 holdMs,
        int64 finishMs,
        uint8 coresFound
    );

    error NotRegistrar();
    error EmptyMatch();
    error TooManyPlayers();

    mapping(uint256 => Match) public matches;

    constructor(address registrar_) {
        registrar = registrar_;
    }

    /// @notice Record one finished match: a header event plus one PlayerScored
    /// event per racer, all in this single transaction.
    /// @param courseId The course id, e.g. "takk-newyork".
    /// @param mode 0 = hold, 1 = reach, 2 = hunt.
    /// @param winner Winner's wallet. May be address(0) for a draw or for
    /// guests whose identity is not on-chain yet (Stage 1).
    /// @param players One entry per racer present at match end, in standings
    /// order.
    function registerMatch(
        string calldata courseId,
        uint8 mode,
        address winner,
        PlayerResult[] calldata players
    ) external returns (uint256 matchId) {
        if (msg.sender != registrar) revert NotRegistrar();
        if (players.length == 0) revert EmptyMatch();
        if (players.length > type(uint8).max) revert TooManyPlayers();

        matchId = ++matchCount;
        uint64 endedAt = uint64(block.timestamp);
        uint8 count = uint8(players.length);

        matches[matchId] = Match(winner, courseId, mode, endedAt, count);
        emit MatchRegistered(matchId, winner, courseId, mode, endedAt, count);

        for (uint256 i = 0; i < players.length; i++) {
            PlayerResult calldata r = players[i];
            emit PlayerScored(matchId, r.wallet, r.holdMs, r.finishMs, r.coresFound);
        }
    }
}