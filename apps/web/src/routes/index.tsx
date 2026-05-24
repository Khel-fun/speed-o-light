import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bomb, CircleUserRound, ExternalLink, Loader2, Trophy, Zap } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { shortenAddress } from "@/lib/shorten-address";
import { publishSettlementOnChain } from "@/lib/publish-settlement";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/")({
  component: SpeedOLight,
});

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------
const GRID_SIZE = 25;
const SESSION_LIMIT = 60_000;
const SPAWN_FREQ = 440;
const GLOW_DURATION = 800;
const XP_PER_HIT = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Tile = { index: number; is_danger: boolean };
type Tap = { seq_pos: string; grid_index: string; is_danger: boolean; is_tapped: boolean };
type ActiveLight = { slotIndex: number; tileIndex: number; isDanger: boolean; expiresAt: number };
type GameState = "IDLE" | "STARTING" | "PLAYING" | "FINISHED" | "VERIFYING";
type PendingSubmit = {
  sessionId: string;
  playerAddress: string;
  tapSequence: Tap[];
  dangerTap: Tap;
};
type ChainPublishNotice = {
  tone: "cancelled" | "error";
  message: string;
};

const TERMINAL_STATUSES = ["FINALIZED", "AGGREGATED", "FAILED"];

function walletErrorMessage(err: unknown): string {
  const details: string[] = [];
  let current: unknown = err;

  while (current && typeof current === "object") {
    const o = current as { code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    if (typeof o.code === "number") details.push(String(o.code));
    if (typeof o.shortMessage === "string") details.push(o.shortMessage);
    if (typeof o.message === "string") details.push(o.message);
    current = o.cause;
  }

  if (err instanceof Error && err.message) details.push(err.message);
  return details.join(" ");
}

function normalizeChainPublishError(err: unknown): ChainPublishNotice {
  const message = walletErrorMessage(err);

  if (
    /\b4001\b/.test(message) ||
    /user rejected/i.test(message) ||
    /rejected the request/i.test(message) ||
    /request rejected/i.test(message) ||
    /denied transaction signature/i.test(message)
  ) {
    return {
      tone: "cancelled",
      message: "Transaction signing was cancelled.",
    };
  }

  return {
    tone: "error",
    message: err instanceof Error && err.message ? err.message : "On-chain publish failed.",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function SpeedOLight() {
  const wallet = useWallet();
  const [gameState, setGameState] = useState<GameState>("IDLE");
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(SESSION_LIMIT);
  const [activeLights, setActiveLights] = useState<ActiveLight[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWinner, setIsWinner] = useState(false);
  const [chainTxHash, setChainTxHash] = useState<`0x${string}` | null>(null);
  const [chainPublishNotice, setChainPublishNotice] = useState<ChainPublishNotice | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  /** Wallet address this session was started with (must match for on-chain publish). */
  const [sessionPlayerAddress, setSessionPlayerAddress] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  // Refs hold mutable game state so the RAF loop is always fresh
  const isPlayingRef = useRef(false);
  const aliveRef = useRef<ActiveLight[]>([]);          // single source of truth for active lights
  const tapRecord = useRef<boolean[]>([]);              // per-slot tap flag (136 entries)
  const dangerTapRef = useRef<{ slotIndex: number } | null>(null);
  const spawnIndexRef = useRef(0);
  const nextSpawnRef = useRef(0);
  const startTimeRef = useRef(0);
  const gameLoopRef = useRef(0);
  const gridSeqRef = useRef<Tile[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const playerAddrRef = useRef("");
  const pendingSubmitRef = useRef<PendingSubmit | null>(null);

  const newGameMutation = useMutation(trpc.newGame.mutationOptions());
  const submitMutation = useMutation(trpc.submitSession.mutationOptions());

  const statusQuery = useQuery({
    ...trpc.getSessionStatus.queryOptions({ sessionId: sessionId! }),
    enabled: gameState === "VERIFYING" && !!sessionId,
    refetchInterval: (query) => {
      const status = query.state.data?.verificationStatus;
      if (!status) return 5000;
      return TERMINAL_STATUSES.includes(status) ? false : 5000;
    },
  });

  // ---------------------------------------------------------------------------
  // Core game functions (stable callbacks — read only from refs)
  // ---------------------------------------------------------------------------

  const endGame = useCallback(() => {
    isPlayingRef.current = false;
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);

    const won = dangerTapRef.current === null;
    setIsWinner(won);
    aliveRef.current = [];
    setActiveLights([]);

    // Snapshot submission data while refs are still live
    const tapSequence: Tap[] = gridSeqRef.current.map((tile, i) => ({
      seq_pos: String(i),
      grid_index: String(tile.index),
      is_danger: tile.is_danger,
      is_tapped: tapRecord.current[i] ?? false,
    }));
    const dangerTap: Tap = dangerTapRef.current
      ? {
          seq_pos: String(dangerTapRef.current.slotIndex),
          grid_index: String(gridSeqRef.current[dangerTapRef.current.slotIndex]!.index),
          is_danger: true,
          is_tapped: true,
        }
      : { seq_pos: "255", grid_index: "255", is_danger: false, is_tapped: false };

    pendingSubmitRef.current = {
      sessionId: sessionIdRef.current!,
      playerAddress: playerAddrRef.current,
      tapSequence,
      dangerTap,
    };

    setGameState("FINISHED");
  }, []);

  const update = useCallback(() => {
    if (!isPlayingRef.current) return;

    const now = Date.now();
    const remaining = Math.max(0, SESSION_LIMIT - (now - startTimeRef.current));
    setTimeLeft(remaining);

    if (remaining <= 0) {
      endGame();
      return;
    }

    let alive = aliveRef.current.filter((l) => l.expiresAt > now);

    if (now >= nextSpawnRef.current && spawnIndexRef.current < 136) {
      const slot = spawnIndexRef.current++;
      const tile = gridSeqRef.current[slot];
      alive = [
        ...alive,
        { slotIndex: slot, tileIndex: tile.index, isDanger: tile.is_danger, expiresAt: now + GLOW_DURATION },
      ];
      nextSpawnRef.current = now + SPAWN_FREQ;
    }

    aliveRef.current = alive;
    setActiveLights([...alive]);

    if (spawnIndexRef.current >= 136 && alive.length === 0) {
      endGame();
      return;
    }

    gameLoopRef.current = requestAnimationFrame(update);
  }, [endGame]);

  const handleTap = useCallback(
    (light: ActiveLight) => {
      if (!isPlayingRef.current) return;
      tapRecord.current[light.slotIndex] = true;
      if (light.isDanger) {
        dangerTapRef.current = { slotIndex: light.slotIndex };
        endGame();
        return;
      }
      setScore((s) => s + 1);
      aliveRef.current = aliveRef.current.filter((l) => l.slotIndex !== light.slotIndex);
      setActiveLights([...aliveRef.current]);
    },
    [endGame],
  );

  const startNewGame = useCallback(() => {
    const addr = wallet.address?.trim() ?? "";
    if (!addr) return;
    isPlayingRef.current = false;
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    playerAddrRef.current = addr;
    submitMutation.reset();
    setChainTxHash(null);
    setChainPublishNotice(null);
    setSessionId(null);
    setSessionPlayerAddress(null);
    setIsWinner(false);
    setScore(0);
    setTimeLeft(SESSION_LIMIT);
    aliveRef.current = [];
    setActiveLights([]);
    tapRecord.current = new Array(136).fill(false);
    dangerTapRef.current = null;
    spawnIndexRef.current = 0;
    pendingSubmitRef.current = null;
    sessionIdRef.current = null;
    setGameState("STARTING");

    newGameMutation.mutate(
      { playerAddress: addr },
      {
        onSuccess: ({ sessionId: id, gridSequence }) => {
          setChainTxHash(null);
          setChainPublishNotice(null);
          setSessionPlayerAddress(addr);

          const now = Date.now();
          startTimeRef.current = now;
          nextSpawnRef.current = now;
          gridSeqRef.current = gridSequence;
          sessionIdRef.current = id;

          setSessionId(id);
          isPlayingRef.current = true;
          setGameState("PLAYING");
        },
        onError: () => setGameState("IDLE"),
      },
    );
  }, [wallet.address, newGameMutation, submitMutation]);

  const resetToIdle = useCallback(() => {
    isPlayingRef.current = false;
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    aliveRef.current = [];
    setActiveLights([]);
    setGameState("IDLE");
    setScore(0);
    setTimeLeft(SESSION_LIMIT);
    setSessionId(null);
    setChainTxHash(null);
    setChainPublishNotice(null);
    setSessionPlayerAddress(null);
    submitMutation.reset();
  }, [submitMutation]);

  const confirmDisconnect = useCallback(() => {
    resetToIdle();
    wallet.disconnect();
    setShowDisconnectConfirm(false);
  }, [resetToIdle, wallet]);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Start / stop the RAF loop with the game
  useEffect(() => {
    if (gameState !== "PLAYING") return;
    gameLoopRef.current = requestAnimationFrame(update);
    return () => {
      if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    };
  }, [gameState, update]);

  useEffect(() => {
    if (!wallet.address) setShowDisconnectConfirm(false);
  }, [wallet.address]);

  // Auto-submit once the game finishes; pendingSubmitRef is nulled after first run
  useEffect(() => {
    if (gameState !== "FINISHED" || !pendingSubmitRef.current) return;
    const data = pendingSubmitRef.current;
    pendingSubmitRef.current = null;
    submitMutation.mutate(data, {
      onSuccess: () => setGameState("VERIFYING"),
    });
  }, [gameState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Derived verification state
  // ---------------------------------------------------------------------------
  const verificationStatus = statusQuery.data?.verificationStatus ?? null;
  const verificationFailed = verificationStatus === "FAILED";
  const verificationSettled =
    gameState === "VERIFYING" &&
    verificationStatus != null &&
    verificationStatus !== "QUEUED";
  const resultState = gameState === "FINISHED" || gameState === "VERIFYING";
  const proofReady = gameState === "VERIFYING" && verificationSettled;

  const settlement =
    submitMutation.data?.settlement ?? statusQuery.data?.settlement ?? null;

  const publishToChain = useCallback(async () => {
    if (!settlement || !wallet.address) return;
    setChainPublishNotice(null);
    setIsPublishing(true);
    try {
      const hash = await publishSettlementOnChain(settlement, wallet.address as `0x${string}`);
      setChainTxHash(hash);
    } catch (e) {
      setChainPublishNotice(normalizeChainPublishError(e));
    } finally {
      setIsPublishing(false);
    }
  }, [settlement, wallet.address]);
  return (
    <main className="min-h-svh overflow-hidden bg-[#020202] text-white font-sans">
      <div className="flex min-h-svh w-full flex-col px-4 py-0 sm:px-6 sm:py-6 lg:px-[64px] lg:py-[64px]">
        <header className="-mx-4 flex h-[224px] shrink-0 flex-col items-center gap-[92px] bg-[#020202] px-4 pt-[60px] sm:mx-0 sm:h-auto sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:bg-transparent sm:p-0">
          <div className="max-w-full text-center text-[38px] font-black italic leading-none text-white drop-shadow-[0_4px_9px_rgba(255,255,255,0.38)] sm:text-left sm:text-[22px] lg:mt-2">
            SPEED-O-LIGHT
          </div>

          <div className="relative flex flex-col items-center gap-2 sm:items-end">
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {!wallet.address ? (
                <button
                  type="button"
                  onClick={() => void wallet.connect()}
                  disabled={wallet.isConnecting}
                  className="inline-flex h-8 items-center justify-center rounded-full border border-white/55 bg-white/10 px-4 font-mono text-[13px] font-medium lowercase tracking-[0.08em] text-white transition-colors hover:border-white/70 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 sm:border-white/30 sm:bg-white/7 sm:text-[11px] sm:tracking-normal"
                >
                  {wallet.isConnecting ? "connecting..." : "connect wallet"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDisconnectConfirm((open) => !open)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/25 bg-white/7 px-3 font-mono text-[11px] text-white/75 transition-colors hover:border-white/50 hover:text-white sm:border-white/45 sm:bg-[#252525] sm:font-medium sm:text-white"
                >
                  <CircleUserRound className="size-[13px]" strokeWidth={1.8} />
                  {shortenAddress(wallet.address.toLowerCase(), 6, 4)}
                </button>
              )}
            </div>

            {showDisconnectConfirm && wallet.address && (
              <div className="absolute left-0 top-[calc(100%+12px)] z-50 w-[310px] rounded-[8px] border border-white/25 bg-[#202020] px-6 py-5 text-center text-white shadow-[0_18px_70px_rgba(0,0,0,0.62)] sm:left-auto sm:right-0 sm:top-[calc(100%+16px)]">
                <div className="absolute -top-[5px] left-8 size-2.5 rotate-45 border-l border-t border-white/25 bg-[#202020] sm:left-auto sm:right-12" />
                <h2 className="text-[17px] font-medium leading-none">Disconnect Wallet?</h2>
                <p className="mt-3 text-[12px] leading-snug text-white/62">
                  You may lose your progress in the match.
                </p>
                <div className="mt-6 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em]">
                  <button
                    type="button"
                    onClick={() => setShowDisconnectConfirm(false)}
                    className="rounded-full px-2 py-1 text-white transition-colors hover:text-white/70"
                  >
                    CANCEL
                  </button>
                  <button
                    type="button"
                    onClick={confirmDisconnect}
                    className="rounded-full px-2 py-1 text-red-400 transition-colors hover:text-red-300"
                  >
                    DISCONNECT
                  </button>
                </div>
              </div>
            )}

            {wallet.error && (
              <p className="max-w-[280px] text-[11px] leading-snug text-red-300 sm:text-right">
                {wallet.error}
              </p>
            )}
          </div>
        </header>

        <section className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-start gap-2 pt-5 sm:justify-center sm:gap-3 sm:py-8 lg:-translate-y-[2px] lg:py-0">
          <div className="grid grid-cols-2 items-end gap-3">
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-white/65 sm:text-[11px]">
                Time Remaining
              </div>
              <div
                className={`font-mono text-[1.75rem] font-black italic leading-none tabular-nums sm:text-[30px] ${
                  resultState ? "text-[#2c2b37]" : "text-white"
                }`}
              >
                {(timeLeft / 1000).toFixed(2)} s
              </div>
            </div>
            <div className="text-right">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-white/65 sm:text-[11px]">
                Total XP
              </div>
              <div
                className={`font-mono text-[1.75rem] font-black italic leading-none tabular-nums sm:text-[30px] ${
                  resultState ? "text-[#4c00ff]" : "text-white"
                }`}
              >
                {(score * XP_PER_HIT).toString().padStart(3, "0")}
              </div>
            </div>
          </div>

          <div className={`h-[6px] overflow-hidden rounded-full ${resultState ? "bg-white/90" : "bg-white/8"}`}>
            <div
              className={`h-full rounded-full transition-all duration-100 ease-linear ${
                resultState
                  ? "bg-[#4c00ff]/45"
                  : "bg-[#4c00ff] shadow-[0_0_18px_rgba(76,0,255,0.7)]"
              }`}
              style={{ width: `${(timeLeft / SESSION_LIMIT) * 100}%` }}
            />
          </div>

          <div className="relative mx-auto mt-6 overflow-visible sm:mt-2">
            <div className="grid grid-cols-5 gap-2.5 rounded-[2rem] border-[3px] border-neutral-800 bg-neutral-900 p-3 shadow-2xl sm:gap-3 sm:rounded-[2.5rem] sm:border-4 sm:p-4">
              {[...Array(GRID_SIZE)].map((_, cellIdx) => {
                const light = activeLights.find((l) => l.tileIndex === cellIdx);
                return (
                  <button
                    key={cellIdx}
                    disabled={gameState !== "PLAYING"}
                    onPointerDown={() => light && handleTap(light)}
                    aria-label={`Tile ${cellIdx + 1}`}
                    className={[
                      "relative flex h-[52px] w-[52px] items-center justify-center overflow-hidden rounded-xl transition-all duration-75 sm:h-16 sm:w-16 sm:rounded-2xl",
                      "disabled:cursor-default",
                      light
                        ? light.isDanger
                          ? "scale-105 bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.4)] active:scale-90"
                          : "scale-105 bg-blue-500 text-white shadow-[0_0_20px_rgba(59,130,246,0.4)] active:scale-90"
                        : "scale-100 bg-neutral-800/40",
                    ].join(" ")}
                  >
                    {light && (
                      <>
                        <div className="relative z-10 animate-in zoom-in duration-150">
                          {light.isDanger ? (
                            <Bomb size={24} />
                          ) : (
                            <Zap size={24} fill="currentColor" />
                          )}
                        </div>
                        <div
                          className="absolute inset-0 origin-left bg-white/20"
                          style={{ animation: `shrink ${GLOW_DURATION}ms linear forwards` }}
                        />
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            {gameState !== "PLAYING" && (
              <div
                className={[
                  "absolute inset-0 z-20 flex flex-col items-center rounded-[2rem] bg-[#050505]/66 p-4 text-center sm:rounded-[2.5rem] sm:p-6",
                  resultState
                    ? "justify-start overflow-hidden px-5 pb-5 pt-6 sm:px-6 sm:pb-6 sm:pt-7"
                    : "justify-center overflow-y-auto",
                ].join(" ")}
              >
                {gameState === "IDLE" && (
                  <div className="flex w-full max-w-[330px] flex-col items-center">
                    <p className="mb-3 text-[13px] font-medium italic leading-snug text-white sm:text-[16px]">
                      60s High-Intensity Sprint
                    </p>
                    <p className="mb-11 text-[13px] font-medium italic leading-snug text-white sm:text-[16px]">
                      Avoid the bombs. Harvest the XP.
                    </p>

                    {!wallet.address ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void wallet.connect()}
                          disabled={wallet.isConnecting}
                          className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#4c00ff] px-6 text-[11px] font-black uppercase text-white shadow-[0_0_30px_rgba(76,0,255,0.45)] transition-transform hover:scale-[1.02] hover:bg-[#5d16ff] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {wallet.isConnecting ? "Connecting..." : "Connect Wallet"}
                        </button>
                        <p className="mt-4 text-center text-[8px] font-medium uppercase text-[#bda8ff]">
                          * Connect your wallet to continue
                        </p>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={startNewGame}
                        disabled={newGameMutation.isPending || isPublishing}
                        className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#4c00ff] px-8 text-xs font-black uppercase text-white shadow-[0_0_30px_rgba(76,0,255,0.45)] transition-transform hover:scale-[1.02] hover:bg-[#5d16ff] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {newGameMutation.isPending ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          "Start Match"
                        )}
                      </button>
                    )}
                  </div>
                )}

                {gameState === "STARTING" && (
                  <div className="text-sm font-medium italic text-white animate-pulse">
                    Setting up the lights ...
                  </div>
                )}

                {resultState && (
                  <div className="flex w-full max-w-[330px] flex-col items-center animate-in fade-in zoom-in duration-300">
                    <div
                      className={`mb-3 flex size-[50px] items-center justify-center rounded-full sm:size-[56px] ${
                        isWinner
                          ? "bg-lime-500/30 text-lime-300 shadow-[0_0_18px_rgba(132,204,22,0.22)]"
                          : "bg-red-600/35 text-red-400 shadow-[0_0_18px_rgba(220,38,38,0.2)]"
                      }`}
                    >
                      {isWinner ? (
                        <Trophy className="size-[25px] sm:size-[28px]" />
                      ) : (
                        <Bomb className="size-[25px] sm:size-[28px]" />
                      )}
                    </div>

                    <h2 className="mb-2 text-[1.55rem] font-black uppercase italic leading-none text-white sm:text-[1.9rem]">
                      {isWinner ? "Session Complete" : "Terminated"}
                    </h2>
                    <p className="mb-4 text-[10px] font-medium uppercase tracking-[0.18em] text-white/75 sm:mb-5 sm:text-[12px]">
                      {isWinner ? "You survived the match !" : "Fatal contact with danger light"}
                    </p>

                    <div className="mb-3 grid grid-cols-2 gap-3 sm:mb-4">
                      <div className="flex min-h-[72px] w-[124px] flex-col items-center justify-center rounded-[12px] border border-white/15 bg-[#1b1920] px-3 py-2 sm:w-[138px]">
                        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/80 sm:text-[12px]">Total XP</div>
                        <div className="mt-2 font-mono text-[1.7rem] font-black italic leading-none text-[#4c00ff] sm:text-[1.9rem]">
                          {score * XP_PER_HIT}
                        </div>
                      </div>
                      <div className="flex min-h-[72px] w-[124px] flex-col items-center justify-center rounded-[12px] border border-white/15 bg-[#222222] px-3 py-2 sm:w-[138px]">
                        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/80 sm:text-[12px]">Hits</div>
                        <div className="mt-2 font-mono text-[1.7rem] font-black italic leading-none text-white sm:text-[1.9rem]">
                          {score}
                        </div>
                      </div>
                    </div>

                    {gameState === "FINISHED" && submitMutation.isError ? (
                      <div className="flex w-full max-w-[270px] flex-col items-center gap-3">
                        <p className="text-[11px] leading-snug text-red-200/90">
                          {submitMutation.error?.message ??
                            "Could not submit session. Check the API logs, run `pnpm db:seed`, and ensure Redis is running."}
                        </p>
                        <button
                          type="button"
                          onClick={resetToIdle}
                          className="rounded-full border border-[#7d50ff] px-5 py-2 text-[10px] font-black uppercase text-white hover:bg-white/10"
                        >
                          New Match
                        </button>
                      </div>
                    ) : proofReady ? (
                      <div className="flex w-full max-w-[300px] flex-col items-center gap-2">
                        <p
                          className={`text-[13px] font-medium italic sm:text-[17px] ${
                            verificationFailed ? "text-amber-300" : "text-lime-300"
                          }`}
                        >
                          {verificationFailed ? "Proofs Need Review." : "Proofs Verified."}
                        </p>

                        {settlement && !chainTxHash && (
                          <button
                            type="button"
                            onClick={() => void publishToChain()}
                            disabled={
                              isPublishing ||
                              !wallet.address ||
                              !sessionPlayerAddress ||
                              wallet.address.toLowerCase() !== sessionPlayerAddress.toLowerCase()
                            }
                            className="inline-flex min-h-9 items-center justify-center rounded-full bg-linear-to-r from-[#c43bf2] to-[#ff7a35] px-5 text-[11px] font-black uppercase tracking-[0.12em] text-white shadow-[0_0_20px_rgba(196,59,242,0.22)] disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-12 sm:px-7 sm:text-[15px] lg:min-w-[252px]"
                          >
                            {isPublishing ? "Confirm in wallet..." : "Publish XP Onchain"}
                          </button>
                        )}

                        {chainTxHash && (
                          <a
                            href={`https://basescan.org/tx/${chainTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center gap-2 px-1 py-2 text-[11px] font-black uppercase tracking-[0.12em] transition-opacity hover:opacity-80 sm:text-[15px]"
                          >
                            <ExternalLink size={12} className="text-[#ff7a35]" />
                            <span className="bg-linear-to-r from-[#c43bf2] to-[#ff7a35] bg-clip-text text-transparent">
                              View Onchain
                            </span>
                          </a>
                        )}

                        {chainPublishNotice && (
                          <p
                            className={`max-w-[240px] rounded-[8px] border px-3 py-2 text-center text-[10px] font-medium leading-snug ${
                              chainPublishNotice.tone === "cancelled"
                                ? "border-amber-300/25 bg-amber-300/8 text-amber-200"
                                : "border-red-400/25 bg-red-500/8 text-red-200"
                            }`}
                          >
                            {chainPublishNotice.message}
                          </p>
                        )}

                      </div>
                    ) : (
                      <div className="flex w-full max-w-[290px] flex-col items-center">
                        <p className="mb-2 text-[10px] font-medium italic text-white/70">
                          generating proofs ...
                        </p>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#d9c9ff]">
                          <div
                            className="h-full w-1/3 rounded-full bg-[#4c00ff]/50"
                            style={{ animation: "verifyBar 2.2s ease-in-out infinite" }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {proofReady ? (
            <button
              type="button"
              onClick={startNewGame}
              disabled={!wallet.address || newGameMutation.isPending || isPublishing}
              className="mx-auto mt-3 inline-flex min-h-9 items-center justify-center rounded-full border border-[#7d50ff] px-6 text-[11px] font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-12 sm:px-7 sm:text-[15px] lg:min-w-[165px]"
            >
              {newGameMutation.isPending ? "Starting..." : "New Match"}
            </button>
          ) : !resultState ? (
            <div className="mt-6 flex w-full items-center justify-center gap-[72px] text-[11px] font-medium uppercase text-white/85 sm:hidden">
              <div className="flex items-center gap-2">
                <div className="size-5 rounded-[4px] bg-[#4c00ff] shadow-[0_0_10px_rgba(76,0,255,0.75)]" />
                <span>Reward</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="size-5 rounded-[4px] bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.65)]" />
                <span>Danger</span>
              </div>
            </div>
          ) : null}
        </section>

      </div>

      <style>{`
        @keyframes shrink {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
        @keyframes verifyBar {
          0%   { transform: translateX(-120%); opacity: 0.85; }
          50%  { transform: translateX(40%); opacity: 1; }
          100% { transform: translateX(220%); opacity: 0.85; }
        }
      `}</style>
    </main>
  );
}
