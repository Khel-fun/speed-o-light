import type { Chain } from "viem";
import { baseSepolia } from "viem/chains";
import { env } from "@speed-o-light/env/web";

/** Base Sepolia (chain must match `VITE_CHAIN_ID` in `apps/web/.env`). */
export function getSettlementChain(): Chain {
  if (env.VITE_CHAIN_ID !== baseSepolia.id) {
    throw new Error(
      `Expected Base Sepolia (chain id ${baseSepolia.id}). Set VITE_CHAIN_ID=${baseSepolia.id} in apps/web/.env`,
    );
  }
  return baseSepolia;
}

export async function ensureBaseSepolia(ethereum: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}) {
  const chain = getSettlementChain();
  const chainIdHex = `0x${chain.id.toString(16)}` as `0x${string}`;
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code !== 4902) throw e;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [chain.blockExplorers?.default?.url ?? "https://sepolia.basescan.org"],
        },
      ],
    });
  }
}
