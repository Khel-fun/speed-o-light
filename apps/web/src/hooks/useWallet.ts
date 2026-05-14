import { useCallback, useEffect, useState } from "react";
import { getAddress } from "viem";

import { ensureBaseSepolia } from "@/lib/base-sepolia";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getEthereum(): EthereumProvider | undefined {
  return typeof window !== "undefined" ? (window as unknown as { ethereum?: EthereumProvider }).ethereum : undefined;
}

export function shortenAddress(addr: string, left = 6, right = 4) {
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}

export function useWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readConnectedAccounts = useCallback(async (eth: EthereumProvider) => {
    const raw = (await eth.request({ method: "eth_accounts" })) as string[];
    const first = raw?.[0];
    if (first && /^0x[0-9a-fA-F]{40}$/.test(first)) {
      setAddress(getAddress(first as `0x${string}`));
    } else {
      setAddress(null);
    }
  }, []);

  useEffect(() => {
    const eth = getEthereum();
    if (!eth) return;

    void readConnectedAccounts(eth);

    const onAccounts = (accs: unknown) => {
      const list = accs as string[] | undefined;
      if (!list?.length) {
        setAddress(null);
        return;
      }
      const first = list[0];
      if (first && /^0x[0-9a-fA-F]{40}$/.test(first)) {
        setAddress(getAddress(first as `0x${string}`));
      }
    };
    const onChainChanged = () => {
      void readConnectedAccounts(eth);
    };

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChainChanged);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, [readConnectedAccounts]);

  const connect = useCallback(async () => {
    setError(null);
    const eth = getEthereum();
    if (!eth) {
      setError("Install a wallet (e.g. MetaMask) to connect.");
      return;
    }
    setIsConnecting(true);
    try {
      await ensureBaseSepolia(eth);
      const raw = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const first = raw?.[0];
      if (!first || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
        setError("No account returned from wallet.");
        return;
      }
      setAddress(getAddress(first as `0x${string}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect wallet.");
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  return {
    address,
    isConnecting,
    error,
    connect,
    disconnect,
    hasInjectedProvider: typeof window !== "undefined" && !!getEthereum(),
  };
}
