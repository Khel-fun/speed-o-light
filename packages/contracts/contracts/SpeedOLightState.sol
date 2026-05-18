// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SpeedOLightState
 * @notice On-chain settlement contract for Speed-O-Light ZK game.
 * @dev Follows an Off-Chain Engine / On-Chain Settlement model.
 *      The backend signs game results with ECDSA; players broadcast
 *      the signed payload to mint XP and update stats on-chain.
 *      The contract itself never performs ZK verification — that
 *      happens off-chain via zkVerify / Kurier.
 */
contract SpeedOLightState is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ──────────────────── Types ────────────────────

    struct PlayerStats {
        uint256 totalXP;
        uint256 gamesPlayed;
        uint256 gamesWon;
        uint256 bestScore;
    }

    struct LeaderboardEntry {
        address player;
        uint256 bestScore;
        uint256 bestXP;
    }

    // ──────────────────── State ────────────────────

    /// @notice The address whose ECDSA signatures are treated as authoritative.
    address public serverSigner;

    /// @notice Cumulative stats per player wallet.
    mapping(address => PlayerStats) public players;

    /// @notice Tracks consumed Game IDs for replay protection.
    mapping(bytes32 => bool) public processedGames;

    /// @notice Leaderboard (top 100 players by best score).
    LeaderboardEntry[] public leaderboard;

    /// @notice Maximum leaderboard size.
    uint256 public constant MAX_LEADERBOARD_SIZE = 100;

    /// @notice Maps player address to their leaderboard index + 1 (0 = not on leaderboard).
    mapping(address => uint256) private playerLeaderboardIndex;

    // ──────────────────── Events ───────────────────

    /// @notice Emitted when a game result is successfully published.
    event GameResultPublished(
        address indexed player,
        bytes32 indexed gameId,
        uint256 score,
        uint256 xpEarned,
        bool won
    );

    /// @notice Emitted when the authorised server signer is rotated.
    event ServerSignerUpdated(address indexed oldSigner, address indexed newSigner);

    /// @notice Emitted when leaderboard is updated.
    event LeaderboardUpdated(
        address indexed player,
        uint256 newBestScore,
        uint256 newBestXP,
        uint256 rank
    );

    // ──────────────────── Errors ───────────────────

    error GameAlreadyProcessed(bytes32 gameId);
    error InvalidServerSignature();
    error ZeroAddressSigner();

    // ──────────────────── Constructor ──────────────

    constructor(address _serverSigner, address _owner) Ownable(_owner) {
        if (_serverSigner == address(0)) revert ZeroAddressSigner();
        serverSigner = _serverSigner;
    }

    // ──────────────── External Functions ───────────

    /**
     * @notice Publish a verified game result on-chain.
     * @dev    The caller (msg.sender) MUST be the player whose address was
     *         included in the server's signed payload. This prevents front-running.
     * @param gameId    Unique identifier for the completed game.
     * @param score     Number of correct taps.
     * @param xpEarned  XP awarded by the backend for this game.
     * @param won       Whether the player completed without tapping danger.
     * @param signature ECDSA signature produced by the backend over
     *                  `keccak256(abi.encodePacked(gameId, msg.sender, score, xpEarned, won))`.
     */
    function publishResult(
        bytes32 gameId,
        uint256 score,
        uint256 xpEarned,
        bool won,
        bytes calldata signature
    ) external {
        // 1. Replay protection
        if (processedGames[gameId]) revert GameAlreadyProcessed(gameId);

        // 2. Reconstruct the hash the server signed
        bytes32 dataHash = keccak256(
            abi.encodePacked(gameId, msg.sender, score, xpEarned, won)
        );
        bytes32 ethSignedHash = dataHash.toEthSignedMessageHash();

        // 3. Recover signer and validate
        address recovered = ethSignedHash.recover(signature);
        if (recovered != serverSigner) revert InvalidServerSignature();

        // 4. Mark game as consumed
        processedGames[gameId] = true;

        // 5. Update player stats
        PlayerStats storage stats = players[msg.sender];
        stats.totalXP += xpEarned;
        stats.gamesPlayed += 1;
        if (won) {
            stats.gamesWon += 1;
        }
        if (score > stats.bestScore) {
            stats.bestScore = score;
        }

        // 6. Update leaderboard
        _updateLeaderboard(msg.sender, score, xpEarned);

        // 7. Emit event for indexers / leaderboards
        emit GameResultPublished(msg.sender, gameId, score, xpEarned, won);
    }

    // ──────────────── Admin Functions ──────────────

    /**
     * @notice Rotate the authorised server signer (key-compromise recovery).
     * @param newSigner The new backend public key address.
     */
    function setServerSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddressSigner();
        address oldSigner = serverSigner;
        serverSigner = newSigner;
        emit ServerSignerUpdated(oldSigner, newSigner);
    }

    // ──────────────── Internal Functions ───────────

    /**
     * @notice Update leaderboard with new player result.
     * @param player Player address
     * @param score Session score
     * @param xp XP earned
     */
    function _updateLeaderboard(address player, uint256 score, uint256 xp) internal {
        uint256 storedIndex = playerLeaderboardIndex[player];

        if (storedIndex != 0) {
            // Player already on leaderboard — O(1) lookup via mapping
            uint256 i = storedIndex - 1;
            if (score > leaderboard[i].bestScore || xp > leaderboard[i].bestXP) {
                leaderboard[i].bestScore = score > leaderboard[i].bestScore ? score : leaderboard[i].bestScore;
                leaderboard[i].bestXP = xp > leaderboard[i].bestXP ? xp : leaderboard[i].bestXP;
                uint256 newIdx = _sortLeaderboard(i);
                playerLeaderboardIndex[player] = newIdx + 1;
                i = newIdx;
            }
            emit LeaderboardUpdated(player, leaderboard[i].bestScore, leaderboard[i].bestXP, i);
            return;
        }

        // New entry
        if (leaderboard.length < MAX_LEADERBOARD_SIZE) {
            leaderboard.push(LeaderboardEntry(player, score, xp));
            uint256 newIndex = leaderboard.length - 1;
            newIndex = _sortLeaderboard(newIndex);
            playerLeaderboardIndex[player] = newIndex + 1;
            emit LeaderboardUpdated(player, score, xp, newIndex);
        } else {
            uint256 lastIdx = leaderboard.length - 1;
            if (score > leaderboard[lastIdx].bestScore || xp > leaderboard[lastIdx].bestXP) {
                // Evict the last (lowest) entry from the mapping
                playerLeaderboardIndex[leaderboard[lastIdx].player] = 0;
                leaderboard[lastIdx] = LeaderboardEntry(player, score, xp);
                uint256 newIndex = _sortLeaderboard(lastIdx);
                playerLeaderboardIndex[player] = newIndex + 1;
                emit LeaderboardUpdated(player, score, xp, newIndex);
            }
        }
    }

    /**
     * @notice Bubble entry at idx upward until sorted; keeps playerLeaderboardIndex in sync.
     * @return Final index the entry settled at.
     */
    function _sortLeaderboard(uint256 idx) internal returns (uint256) {
        while (idx > 0) {
            uint256 prevIdx = idx - 1;
            if (leaderboard[idx].bestScore > leaderboard[prevIdx].bestScore ||
                (leaderboard[idx].bestScore == leaderboard[prevIdx].bestScore &&
                 leaderboard[idx].bestXP > leaderboard[prevIdx].bestXP)) {
                // Update mapping for the displaced entry
                playerLeaderboardIndex[leaderboard[prevIdx].player] = idx + 1;
                // Swap
                LeaderboardEntry memory temp = leaderboard[idx];
                leaderboard[idx] = leaderboard[prevIdx];
                leaderboard[prevIdx] = temp;
                idx = prevIdx;
            } else {
                break;
            }
        }
        return idx;
    }

    // ──────────────── View Functions ───────────────

    /**
     * @notice Retrieve cumulative stats for a player.
     * @param player Wallet address to query.
     */
    function getPlayerStats(address player) external view returns (PlayerStats memory) {
        return players[player];
    }

    /**
     * @notice Get full leaderboard.
     */
    function getLeaderboard() external view returns (LeaderboardEntry[] memory) {
        return leaderboard;
    }

    /**
     * @notice Get top N players.
     */
    function getTopPlayers(uint256 n) external view returns (LeaderboardEntry[] memory) {
        uint256 count = n > leaderboard.length ? leaderboard.length : n;
        LeaderboardEntry[] memory top = new LeaderboardEntry[](count);
        for (uint256 i = 0; i < count; i++) {
            top[i] = leaderboard[i];
        }
        return top;
    }

    /**
     * @notice Check if a game was already processed.
     */
    function isGameProcessed(bytes32 gameId) external view returns (bool) {
        return processedGames[gameId];
    }
}
