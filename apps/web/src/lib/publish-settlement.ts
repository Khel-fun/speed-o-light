import { createPublicClient, createWalletClient, custom, http } from "viem";
import { base } from "viem/chains";
import { env } from "@speed-o-light/env/web";

import { ensureBaseMainnet } from "@/lib/base-mainnet";
import { speedOLightStateAbi } from "@/lib/speed-o-light-state-abi";

export type SettlementPayload = {
  gameId: `0x${string}`;
  score: number;
  xpEarned: number;
  won: boolean;
  signature: `0x${string}`;
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getEthereum(): EthereumProvider | undefined {
  return typeof window !== "undefined"
    ? (window as unknown as { ethereum?: EthereumProvider }).ethereum
    : undefined;
}

export async function publishSettlementOnChain(
  settlement: SettlementPayload,
  playerAddress: `0x${string}`,
): Promise<`0x${string}`> {
  const eth = getEthereum();
  if (!eth) throw new Error("Wallet not available");

  await ensureBaseMainnet(eth);

  const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!from || from.toLowerCase() !== playerAddress.toLowerCase()) {
    throw new Error("Active wallet account does not match the player for this session.");
  }

  const transport = custom(eth);
  const walletClient = createWalletClient({
    chain: base,
    transport,
  });

  const contractAddress = env.VITE_CONTRACT_ADDRESS as `0x${string}`;

  const hash = await walletClient.writeContract({
    account: playerAddress,
    address: contractAddress,
    abi: speedOLightStateAbi,
    functionName: "publishResult",
    args: [
      settlement.gameId,
      BigInt(settlement.score),
      BigInt(settlement.xpEarned),
      settlement.won,
      settlement.signature,
    ],
  });

  return hash;
}

export async function readOnChainPlayerStats(playerAddress: `0x${string}`) {
  const contractAddress = env.VITE_CONTRACT_ADDRESS as `0x${string}`;
  const rpc = base.rpcUrls.default.http[0];
  if (!rpc) throw new Error("No RPC URL for Base Sepolia");

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpc),
  });

  return publicClient.readContract({
    address: contractAddress,
    abi: speedOLightStateAbi,
    functionName: "getPlayerStats",
    args: [playerAddress],
  });
}
