import { encodePacked, keccak256, stringToBytes } from "viem";
import { signMessage } from "viem/accounts";

/** `keccak256` of the session UUID string — matches `publishResult` replay key. */
export function sessionIdToGameId(sessionId: string): `0x${string}` {
  return keccak256(stringToBytes(sessionId));
}

export function settlementDataHash(params: {
  gameId: `0x${string}`;
  player: `0x${string}`;
  score: bigint;
  xpEarned: bigint;
  won: boolean;
}): `0x${string}` {
  return keccak256(
    encodePacked(
      ["bytes32", "address", "uint256", "uint256", "bool"],
      [params.gameId, params.player, params.score, params.xpEarned, params.won],
    ),
  );
}

export type SettlementPayload = {
  gameId: `0x${string}`;
  score: number;
  xpEarned: number;
  won: boolean;
  signature: `0x${string}`;
};

function normalizePrivateKey(key: string): `0x${string}` {
  const trimmed = key.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export async function signSettlementPayload(
  privateKey: string,
  input: {
    sessionId: string;
    playerAddress: `0x${string}`;
    score: number;
    xpEarned: number;
    won: boolean;
  },
): Promise<SettlementPayload> {
  const pk = normalizePrivateKey(privateKey);
  const gameId = sessionIdToGameId(input.sessionId);
  const dataHash = settlementDataHash({
    gameId,
    player: input.playerAddress,
    score: BigInt(input.score),
    xpEarned: BigInt(input.xpEarned),
    won: input.won,
  });
  const signature = await signMessage({
    privateKey: pk,
    message: { raw: dataHash },
  });
  return {
    gameId,
    score: input.score,
    xpEarned: input.xpEarned,
    won: input.won,
    signature,
  };
}
