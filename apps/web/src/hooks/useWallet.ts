import { useCallback, useEffect, useState } from "react";
import { getAddress } from "viem";

import { ensureBaseMainnet } from "@/lib/base-mainnet";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getEthereum(): EthereumProvider | undefined {
  return typeof window !== "undefined" ? (window as unknown as { ethereum?: EthereumProvider }).ethereum : undefined;
}

/** EIP-1193 4001 / provider wording when the user closes or rejects a wallet prompt. */
function messageFromWalletError(err: unknown): string {
  const o = err as { code?: number; message?: string } | null;
  const code = typeof o?.code === "number" ? o.code : undefined;
  const msg = typeof o?.message === "string" ? o.message : "";

  if (code === 4001) {
    return "Connection was cancelled.";
  }
  if (
    /not been authorized by the user/i.test(msg) ||
    /user rejected/i.test(msg) ||
    /rejected the request/i.test(msg) ||
    /request rejected/i.test(msg)
  ) {
    return "Connection was cancelled.";
  }

  if (err instanceof Error && err.message) return err.message;
  if (msg) return msg;
  return "Could not connect wallet.";
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
      await ensureBaseMainnet(eth);
      const raw = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const first = raw?.[0];
      if (!first || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
        setError("No account returned from wallet.");
        return;
      }
      setAddress(getAddress(first as `0x${string}`));
    } catch (e) {
      setError(messageFromWalletError(e));
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
