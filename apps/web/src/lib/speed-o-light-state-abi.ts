/** Minimal ABI for `SpeedOLightState` on-chain settlement. */
export const speedOLightStateAbi = [
  {
    type: "function",
    name: "publishResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "score", type: "uint256" },
      { name: "xpEarned", type: "uint256" },
      { name: "won", type: "bool" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getPlayerStats",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "totalXP", type: "uint256" },
          { name: "gamesPlayed", type: "uint256" },
          { name: "gamesWon", type: "uint256" },
          { name: "bestScore", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isGameProcessed",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
