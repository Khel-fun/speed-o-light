import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bomb, CircleUserRound, ExternalLink, Loader2, Trophy, Zap } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { shortenAddress } from "@/lib/shorten-address";
import { publishSettlementOnChain, readOnChainPlayerStats } from "@/lib/publish-settlement";
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

const TERMINAL_STATUSES = ["FINALIZED", "AGGREGATED", "FAILED"];

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
  const [chainPublishError, setChainPublishError] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [onChainStats, setOnChainStats] = useState<{
    totalXP: bigint;
    gamesPlayed: bigint;
    gamesWon: bigint;
    bestScore: bigint;
  } | null>(null);
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
    playerAddrRef.current = addr;
    submitMutation.reset();
    setChainTxHash(null);
    setChainPublishError(null);
    setOnChainStats(null);
    setGameState("STARTING");

    newGameMutation.mutate(
      { playerAddress: addr },
      {
        onSuccess: ({ sessionId: id, gridSequence }) => {
          setChainTxHash(null);
          setChainPublishError(null);
          setOnChainStats(null);
          setSessionPlayerAddress(addr);
          tapRecord.current = new Array(136).fill(false);
          dangerTapRef.current = null;
          spawnIndexRef.current = 0;
          aliveRef.current = [];
          pendingSubmitRef.current = null;

          const now = Date.now();
          startTimeRef.current = now;
          nextSpawnRef.current = now;
          gridSeqRef.current = gridSequence;
          sessionIdRef.current = id;

          setSessionId(id);
          setScore(0);
          setTimeLeft(SESSION_LIMIT);
          setActiveLights([]);
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
    setChainPublishError(null);
    setOnChainStats(null);
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
    setChainPublishError(null);
    setIsPublishing(true);
    try {
      const hash = await publishSettlementOnChain(settlement, wallet.address as `0x${string}`);
      setChainTxHash(hash);
      const stats = await readOnChainPlayerStats(wallet.address as `0x${string}`);
      setOnChainStats(stats);
    } catch (e) {
      setChainPublishError(e instanceof Error ? e.message : "On-chain publish failed.");
    } finally {
      setIsPublishing(false);
    }
  }, [settlement, wallet.address]);
  return (
    <main className="min-h-svh overflow-hidden bg-[#020202] text-white font-sans">
      <div className="flex min-h-svh w-full flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-[76px] lg:py-[64px]">
        <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-full text-[1.6rem] font-black italic leading-none text-white drop-shadow-[0_4px_9px_rgba(255,255,255,0.38)] sm:text-[1.8rem] lg:mt-2 lg:text-[2.25rem]">
            SPEED-O-LIGHT
          </div>

          <div className="relative flex flex-col items-start gap-2 sm:items-end">
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {!wallet.address ? (
                <button
                  type="button"
                  onClick={() => void wallet.connect()}
                  disabled={wallet.isConnecting}
                  className="inline-flex h-8 items-center justify-center rounded-full border border-white/30 bg-white/7 px-4 font-mono text-[11px] font-medium lowercase text-white transition-colors hover:border-white/55 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wallet.isConnecting ? "connecting..." : "connect wallet"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDisconnectConfirm((open) => !open)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/25 bg-white/7 px-3 font-mono text-[11px] text-white/75 transition-colors hover:border-white/50 hover:text-white sm:h-[52px] sm:gap-3 sm:border-white/45 sm:bg-[#252525] sm:px-5 sm:text-[20px] sm:font-medium sm:text-white"
                >
                  <CircleUserRound className="size-[13px] sm:size-[30px]" strokeWidth={1.8} />
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

        <section
          className={[
            "mx-auto flex w-full max-w-[670px] flex-1 flex-col justify-center gap-2 py-6 sm:gap-3 sm:py-8 lg:scale-[0.80] lg:py-0",
            proofReady ? "lg:translate-y-[6px]" : "lg:-translate-y-[18px]",
          ].join(" ")}
        >
          <div className="grid grid-cols-2 items-end gap-3">
            <div>
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-white/65 sm:text-[11px] lg:text-[20px]">
                Time Remaining
              </div>
              <div
                className={`font-mono text-[1.75rem] font-black italic leading-none tabular-nums sm:text-[2rem] lg:text-[40px] ${
                  resultState ? "text-[#2c2b37]" : "text-white"
                }`}
              >
                {(timeLeft / 1000).toFixed(2)} s
              </div>
            </div>
            <div className="text-right">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-white/65 sm:text-[11px] lg:text-[20px]">
                Total XP
              </div>
              <div
                className={`font-mono text-[1.75rem] font-black italic leading-none tabular-nums sm:text-[2rem] lg:text-[40px] ${
                  resultState ? "text-[#4c00ff]" : "text-white"
                }`}
              >
                {(score * XP_PER_HIT).toString().padStart(3, "0")}
              </div>
            </div>
          </div>

          <div className={`h-1.5 overflow-hidden rounded-full lg:h-[9px] ${resultState ? "bg-white/90" : "bg-white/8"}`}>
            <div
              className={`h-full rounded-full transition-all duration-100 ease-linear ${
                resultState
                  ? "bg-[#4c00ff]/45"
                  : "bg-[#4c00ff] shadow-[0_0_18px_rgba(76,0,255,0.7)]"
              }`}
              style={{ width: `${(timeLeft / SESSION_LIMIT) * 100}%` }}
            />
          </div>

          <div className="relative mt-1 aspect-square w-full overflow-visible rounded-[18px] border border-white/10 bg-[#050505] shadow-[0_0_28px_rgba(0,0,0,0.75)] sm:mt-2">
            <div className="grid size-full grid-cols-5 gap-1.5 overflow-hidden rounded-[18px] p-1.5 sm:gap-2 sm:p-2.5 lg:gap-3">
              {[...Array(GRID_SIZE)].map((_, cellIdx) => {
                const light = activeLights.find((l) => l.tileIndex === cellIdx);
                return (
                  <button
                    key={cellIdx}
                    disabled={gameState !== "PLAYING"}
                    onPointerDown={() => light && handleTap(light)}
                    aria-label={`Tile ${cellIdx + 1}`}
                    className={[
                      "relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-[8px]",
                      "transition-all duration-75 disabled:cursor-default",
                      light
                        ? light.isDanger
                          ? "scale-[1.03] bg-red-500 text-white shadow-[0_0_24px_rgba(239,68,68,0.45)] active:scale-95"
                          : "scale-[1.03] bg-[#4c00ff] text-white shadow-[0_0_24px_rgba(76,0,255,0.55)] active:scale-95"
                        : "scale-100 bg-[#0a0a0a] ring-1 ring-white/[0.02]",
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
                  "absolute inset-0 z-20 flex flex-col items-center rounded-[18px] bg-[#050505]/66 p-4 text-center sm:p-6",
                  resultState
                    ? "justify-start overflow-visible pt-14 sm:pt-[72px] lg:pt-[98px]"
                    : "justify-center overflow-y-auto",
                ].join(" ")}
              >
                {gameState === "IDLE" && (
                  <div className="flex w-full max-w-[330px] flex-col items-center">
                    <p className="mb-4 text-[1rem] font-medium italic leading-snug text-white sm:text-[1.2rem]">
                      60s High-Intensity Sprint
                    </p>
                    <p className="mb-14 text-[1rem] font-medium italic leading-snug text-white sm:text-[1.2rem]">
                      Avoid the bombs. Harvest the XP.
                    </p>

                    {!wallet.address ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void wallet.connect()}
                          disabled={wallet.isConnecting}
                          className="inline-flex min-h-14 items-center justify-center rounded-full bg-[#4c00ff] px-7 text-sm font-black uppercase text-white shadow-[0_0_30px_rgba(76,0,255,0.45)] transition-transform hover:scale-[1.02] hover:bg-[#5d16ff] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {wallet.isConnecting ? "Connecting..." : "Connect Wallet"}
                        </button>
                        <p className="mt-5 text-center text-[10px] font-medium uppercase text-[#bda8ff]">
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
                  <div className="flex w-full max-w-[560px] flex-col items-center animate-in fade-in zoom-in duration-300">
                    <div
                      className={`absolute left-1/2 top-[-12px] flex size-[56px] -translate-x-1/2 items-center justify-center rounded-full sm:size-[70px] lg:top-[-18px] lg:size-[84px] ${
                        isWinner
                          ? "bg-lime-500/30 text-lime-300 shadow-[0_0_18px_rgba(132,204,22,0.22)]"
                          : "bg-red-600/35 text-red-400 shadow-[0_0_18px_rgba(220,38,38,0.2)]"
                      }`}
                    >
                      {isWinner ? (
                        <Trophy className="size-[28px] sm:size-[34px] lg:size-[43px]" />
                      ) : (
                        <Bomb className="size-[28px] sm:size-[34px] lg:size-[43px]" />
                      )}
                    </div>

                    <h2 className="mb-2 text-[1.5rem] font-black uppercase italic leading-none text-white sm:text-[2rem] lg:mb-7 lg:text-[38px]">
                      {isWinner ? "Session Complete" : "Terminated"}
                    </h2>
                    <p className="mb-6 text-[10px] font-medium uppercase tracking-[0.18em] text-white/75 sm:mb-8 sm:text-[14px] lg:mb-[96px] lg:text-[23px]">
                      {isWinner ? "You survived the match !" : "Fatal contact with danger light"}
                    </p>

                    <div className="mb-6 grid grid-cols-2 gap-4 sm:mb-8 lg:mb-[96px] lg:gap-7">
                      <div className="flex min-h-[76px] min-w-[104px] flex-col items-center justify-center rounded-[12px] border border-white/15 bg-[#1b1920] px-4 py-3 sm:min-h-[92px] sm:min-w-[116px] lg:min-h-[128px] lg:min-w-[178px]">
                        <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-white/80 lg:text-[23px]">Total XP</div>
                        <div className="mt-2 font-mono text-[2rem] font-black italic leading-none text-[#4c00ff] lg:mt-6 lg:text-[40px]">
                          {score * XP_PER_HIT}
                        </div>
                      </div>
                      <div className="flex min-h-[76px] min-w-[104px] flex-col items-center justify-center rounded-[12px] border border-white/15 bg-[#222222] px-4 py-3 sm:min-h-[92px] sm:min-w-[116px] lg:min-h-[128px] lg:min-w-[178px]">
                        <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-white/80 lg:text-[23px]">Hits</div>
                        <div className="mt-2 font-mono text-[2rem] font-black italic leading-none text-white lg:mt-6 lg:text-[40px]">
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
                      <div className="flex w-full max-w-[360px] flex-col items-center gap-3 lg:gap-4">
                        <p
                          className={`text-[18px] font-medium italic lg:text-[22px] ${
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
                            className="inline-flex min-h-12 items-center justify-center rounded-full bg-linear-to-r from-[#c43bf2] to-[#ff7a35] px-7 text-[15px] font-black uppercase tracking-[0.12em] text-white shadow-[0_0_20px_rgba(196,59,242,0.22)] disabled:cursor-not-allowed disabled:opacity-45 lg:min-w-[252px]"
                          >
                            {isPublishing ? "Confirm in wallet..." : "Publish XP Onchain"}
                          </button>
                        )}

                        {chainTxHash && (
                          <a
                            href={`https://sepolia.basescan.org/tx/${chainTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-linear-to-r from-[#c43bf2] to-[#ff7a35] px-7 text-[15px] font-black uppercase tracking-[0.12em] text-white lg:min-w-[252px]"
                          >
                            <ExternalLink size={12} />
                            View Onchain
                          </a>
                        )}

                        {chainPublishError && (
                          <p className="max-w-[240px] text-[10px] leading-snug text-red-300">
                            {chainPublishError}
                          </p>
                        )}

                        {onChainStats && chainTxHash && (
                          <p className="font-mono text-[10px] text-white/45">
                            {onChainStats.totalXP.toString()} total XP onchain
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
              className="mx-auto mt-3 inline-flex min-h-12 items-center justify-center rounded-full border border-[#7d50ff] px-7 text-[15px] font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45 lg:min-w-[165px]"
            >
              {newGameMutation.isPending ? "Starting..." : "New Match"}
            </button>
          ) : !resultState ? (
            <div className="mt-1 flex w-full flex-wrap items-center justify-center gap-x-20 gap-y-3 text-[10px] font-bold uppercase text-white/65">
              <div className="flex items-center gap-2">
                <div className="size-3 rounded-[3px] bg-[#4c00ff] shadow-[0_0_12px_rgba(76,0,255,0.75)]" />
                <span>Reward</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="size-3 rounded-[3px] bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.65)]" />
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
