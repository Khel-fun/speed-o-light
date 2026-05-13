/**
 * Contract ABI and TypeScript types for SpeedOLight
 */

export const SpeedOLightABI = [
  // Events
  "event SessionStarted(bytes32 indexed sessionId, address indexed player, bytes32 seed, uint256 timestamp)",
  "event SessionFinished(bytes32 indexed sessionId, address indexed player, uint256 score, uint256 xp, bool isWinner)",
  "event ProofSubmitted(bytes32 indexed sessionId, bytes32 indexed kurierJobId, bytes32 vkHash)",
  "event ProofVerified(bytes32 indexed sessionId, bytes32 indexed kurierJobId, uint8 status, bytes32 txHash)",
  "event VKRegistered(bytes32 indexed vkHash, address indexed registrar)",
  "event OracleAdded(address indexed oracle)",
  "event OracleRemoved(address indexed oracle)",
  "event LeaderboardUpdated(address indexed player, uint256 newBestScore, uint256 newBestXP, uint256 rank)",

  // Enums
  "function VerificationStatus() view returns (uint8 None, uint8 Queued, uint8 Valid, uint8 Submitted, uint8 IncludedInBlock, uint8 Finalized, uint8 AggregationPending, uint8 Aggregated, uint8 Failed)",
  "function SessionStatus() view returns (uint8 Started, uint8 Finished)",

  // Admin
  "function registerVK(bytes32 _vkHash)",
  "function addOracle(address _oracle)",
  "function removeOracle(address _oracle)",

  // Game
  "function startSession(bytes32 _sessionId, bytes32 _seed)",
  "function submitProof(bytes32 _sessionId, bytes32 _kurierJobId, bytes32 _vkHash, bytes _proofData, bytes32[] _publicInputs)",
  "function updateVerificationStatus(bytes32 _kurierJobId, uint8 _status, bytes32 _txHash, uint256 _aggregationId)",
  "function finalizeSession(bytes32 _sessionId, uint256 _score, uint256 _xp, bool _isWinner)",

  // Views
  "function registeredVKs(bytes32) view returns (bool)",
  "function trustedOracles(address) view returns (bool)",
  "function players(address) view returns (uint256 totalXP, uint256 wins, uint256 gamesPlayed, uint256 lastPlayedAt)",
  "function sessions(bytes32) view returns (bytes32 sessionId, address player, bytes32 seed, uint256 score, uint256 xp, bool isWinner, uint8 status, uint256 createdAt, uint256 finishedAt)",
  "function proofs(bytes32) view returns (bytes32 sessionId, bytes32 kurierJobId, bytes32 vkHash, bytes proofData, uint8 status, bytes32 txHash, uint256 aggregationId, uint256 verifiedAt)",
  "function jobToSession(bytes32) view returns (bytes32)",
  "function leaderboardIndex(address) view returns (uint256)",
  "function leaderboard(uint256) view returns (address player, uint256 bestScore, uint256 bestXP, uint256 totalGames)",
  "function LEADERBOARD_SIZE() view returns (uint256)",
  "function getPlayer(address _player) view returns (tuple(uint256 totalXP, uint256 wins, uint256 gamesPlayed, uint256 lastPlayedAt))",
  "function getSession(bytes32 _sessionId) view returns (tuple(bytes32 sessionId, address player, bytes32 seed, uint256 score, uint256 xp, bool isWinner, uint8 status, uint256 createdAt, uint256 finishedAt))",
  "function getProof(bytes32 _sessionId) view returns (tuple(bytes32 sessionId, bytes32 kurierJobId, bytes32 vkHash, bytes proofData, bytes32[] publicInputs, uint8 status, bytes32 txHash, uint256 aggregationId, uint256 verifiedAt))",
  "function getLeaderboard() view returns (tuple(address player, uint256 bestScore, uint256 bestXP, uint256 totalGames)[])",
  "function getTopPlayers(uint256 _n) view returns (tuple(address player, uint256 bestScore, uint256 bestXP, uint256 totalGames)[])",
  "function getPlayerRank(address _player) view returns (uint256)",
  "function getTotalSessions() view returns (uint256)",
  "function isSessionVerified(bytes32 _sessionId) view returns (bool)",
] as const;

// TypeScript types
export enum VerificationStatus {
  None = 0,
  Queued,
  Valid,
  Submitted,
  IncludedInBlock,
  Finalized,
  AggregationPending,
  Aggregated,
  Failed,
}

export enum SessionStatus {
  Started = 0,
  Finished = 1,
}

export interface Player {
  totalXP: bigint;
  wins: bigint;
  gamesPlayed: bigint;
  lastPlayedAt: bigint;
}

export interface GameSession {
  sessionId: `0x${string}`;
  player: `0x${string}`;
  seed: `0x${string}`;
  score: bigint;
  xp: bigint;
  isWinner: boolean;
  status: SessionStatus;
  createdAt: bigint;
  finishedAt: bigint;
}

export interface Proof {
  sessionId: `0x${string}`;
  kurierJobId: `0x${string}`;
  vkHash: `0x${string}`;
  proofData: `0x${string}`;
  publicInputs: `0x${string}`[];
  status: VerificationStatus;
  txHash: `0x${string}`;
  aggregationId: bigint;
  verifiedAt: bigint;
}

export interface LeaderboardEntry {
  player: `0x${string}`;
  bestScore: bigint;
  bestXP: bigint;
  totalGames: bigint;
}

// Contract address constants
export const CONTRACT_ADDRESSES: Record<string, `0x${string}`> = {
  sepolia: "0x", // Deploy and fill in
  baseSepolia: "0x", // Deploy and fill in
  base: "0x", // Deploy and fill in
  mainnet: "0x", // Deploy and fill in
};

// Helper to convert UUID string to bytes32
export function uuidToBytes32(uuid: string): `0x${string}` {
  // Remove hyphens and convert to bytes32
  const clean = uuid.replace(/-/g, "");
  return `0x${clean}`;
}

// Helper to convert bytes32 to UUID string
export function bytes32ToUuid(bytes32: `0x${string}`): string {
  const hex = bytes32.slice(2); // Remove 0x
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
