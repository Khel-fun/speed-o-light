import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bomb, ExternalLink, Loader2, LogOut, Play, ShieldCheck, Timer, Trophy, Wallet, Zap } from "lucide-react";
import { shortenAddress, useWallet } from "@/hooks/useWallet";
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

const VERIFICATION_LABELS: Record<string, string> = {
  QUEUED: "Proof queued...",
  VALID: "Proof valid...",
  SUBMITTED: "Submitted to verifier...",
  INCLUDED_IN_BLOCK: "Included in block...",
  FINALIZED: "Proofs verified. Fairness locked.",
  AGGREGATION_PENDING: "Aggregation pending...",
  AGGREGATED: "Proofs verified. Fairness locked.",
  FAILED: "Verification failed.",
};

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
  /** Kurier fully finished (or aggregated). */
  const verificationFullyDone =
    verificationStatus === "FINALIZED" || verificationStatus === "AGGREGATED";
  const verificationFailed = verificationStatus === "FAILED";
  /**
   * Spinner only until we have a job status beyond Kurier queue.
   * After `SUBMITTED` the proof worker is done; FINALIZED can lag minutes — user can publish meanwhile.
   */
  const verificationPending =
    gameState === "VERIFYING" &&
    (verificationStatus == null || verificationStatus === "QUEUED");
  const verificationSettled =
    gameState === "VERIFYING" &&
    verificationStatus != null &&
    verificationStatus !== "QUEUED";
  const verificationLabel = verificationStatus
    ? (VERIFICATION_LABELS[verificationStatus] ?? "Verifying...")
    : "Generating proof...";

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
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-6 font-sans">

      {/* Shell: width follows the game board so HUD / progress / legend line up with the card */}
      <div className="mx-auto inline-flex max-w-[calc(100vw-3rem)] flex-col items-stretch gap-4">
      {/* Wallet */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!wallet.address ? (
          <button
            type="button"
            onClick={() => void wallet.connect()}
            disabled={wallet.isConnecting || !wallet.hasInjectedProvider}
            className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-colors hover:border-blue-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wallet size={16} />
            {wallet.isConnecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <span className="rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-xs text-neutral-300">
              {shortenAddress(wallet.address)}
            </span>
            <button
              type="button"
              onClick={wallet.disconnect}
              disabled={gameState === "PLAYING" || gameState === "STARTING"}
              className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-neutral-400 transition-colors hover:border-red-500/60 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <LogOut size={14} />
              Disconnect
            </button>
          </>
        )}
      </div>
      {!wallet.hasInjectedProvider && (
        <p className="text-right text-[11px] text-amber-500/90">
          No injected wallet detected. Use a browser with MetaMask (or similar).
        </p>
      )}
      {wallet.error && (
        <p className="text-right text-[11px] text-red-400">{wallet.error}</p>
      )}

      {/* HUD */}
      <div className="flex justify-between items-end gap-4">
        <div>
          <div className="flex items-center gap-2 text-neutral-500 text-xs font-bold uppercase tracking-widest mb-1">
            <Timer size={14} className="text-blue-500" />
            Time Remaining
          </div>
          <div className="text-3xl font-mono font-black italic">
            {(timeLeft / 1000).toFixed(2)}s
          </div>
        </div>
        <div className="text-right">
          <div className="text-neutral-500 text-xs font-bold uppercase tracking-widest mb-1">Total XP</div>
          <div className="text-4xl font-mono font-black text-blue-500 tabular-nums">
            {(score * XP_PER_HIT).toString().padStart(3, "0")}
          </div>
        </div>
      </div>

      {/* Session progress bar */}
      <div className="h-1.5 bg-neutral-900 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-600 transition-all duration-100 ease-linear"
          style={{ width: `${(timeLeft / SESSION_LIMIT) * 100}%` }}
        />
      </div>

      {/* Game board */}
      <div className="relative">
        <div className="grid grid-cols-5 gap-3 p-4 bg-neutral-900 rounded-[2.5rem] border-4 border-neutral-800 shadow-2xl">
          {[...Array(GRID_SIZE)].map((_, cellIdx) => {
            const light = activeLights.find((l) => l.tileIndex === cellIdx);
            return (
              <button
                key={cellIdx}
                disabled={gameState !== "PLAYING"}
                onPointerDown={() => light && handleTap(light)}
                className={[
                  "w-14 h-14 sm:w-16 sm:h-16 rounded-2xl transition-all duration-75 relative",
                  "flex items-center justify-center overflow-hidden",
                  light
                    ? light.isDanger
                      ? "bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)] scale-105 active:scale-90"
                      : "bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)] scale-105 active:scale-90"
                    : "bg-neutral-800/40 scale-100",
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
                      className="absolute inset-0 bg-white/20 origin-left"
                      style={{ animation: `shrink ${GLOW_DURATION}ms linear forwards` }}
                    />
                  </>
                )}
              </button>
            );
          })}
        </div>

        {/* Overlay (shown in all non-PLAYING states) */}
        {gameState !== "PLAYING" && (
          <div
            className={[
              "absolute inset-0 z-20 flex min-h-full flex-col rounded-[2.5rem] border border-neutral-800 bg-neutral-950/90 p-6 backdrop-blur-md sm:p-8",
              verificationSettled
                ? "items-stretch justify-start px-5 pb-0 pt-5 sm:px-8 sm:pb-0 sm:pt-6"
                : "items-center justify-center text-center",
            ].join(" ")}
          >

            {/* IDLE */}
            {gameState === "IDLE" && (
              <>
                <h1 className="text-4xl font-black italic tracking-tighter mb-2">SPEED-O-LIGHT</h1>
                <p className="text-neutral-400 text-sm mb-6 max-w-[240px]">
                  60s High-Intensity Sprint.<br />Avoid the bombs, harvest the XP.
                </p>
                {!wallet.address ? (
                  <button
                    type="button"
                    onClick={() => void wallet.connect()}
                    disabled={wallet.isConnecting || !wallet.hasInjectedProvider}
                    className="mb-4 inline-flex w-full items-center justify-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 py-3 text-xs font-bold uppercase tracking-widest text-white transition-colors hover:border-blue-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Wallet size={18} />
                    {wallet.isConnecting ? "Connecting…" : "Connect wallet to play"}
                  </button>
                ) : (
                  <p className="mb-4 w-full rounded-full border border-neutral-800 bg-neutral-900/80 px-4 py-2 text-center font-mono text-xs text-neutral-400">
                    Playing as {shortenAddress(wallet.address, 8, 6)}
                  </p>
                )}
                <button
                  type="button"
                  onClick={startNewGame}
                  disabled={!wallet.address || newGameMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-black px-10 py-4 rounded-full flex items-center gap-2 transition-transform active:scale-95"
                >
                  <Play size={20} fill="currentColor" /> START MATCH
                </button>
              </>
            )}

            {/* STARTING */}
            {gameState === "STARTING" && (
              <div className="text-neutral-400 text-sm font-bold uppercase tracking-widest animate-pulse">
                Initializing sequence...
              </div>
            )}

            {/* FINISHED / VERIFYING */}
            {(gameState === "FINISHED" || gameState === "VERIFYING") && (
              <div
                className={[
                  "animate-in fade-in zoom-in duration-300 flex w-full flex-col",
                  verificationSettled ? "min-h-0 flex-1" : "",
                ].join(" ")}
              >
                {verificationSettled ? (
                  <>
                    <div className="min-h-0 flex-1 shrink basis-0" aria-hidden />
                    <div className="flex shrink-0 flex-col items-center text-center">
                      <div
                        className={`mx-auto mb-3 w-16 h-16 rounded-full flex items-center justify-center ${isWinner ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500"}`}
                      >
                        {isWinner ? <Trophy size={32} /> : <Bomb size={32} />}
                      </div>
                      <h2 className="text-3xl font-black mb-1">
                        {isWinner ? "SESSION COMPLETE" : "TERMINATED"}
                      </h2>
                      <p className="text-neutral-400 text-sm mb-0">
                        {isWinner
                          ? "You survived the full session!"
                          : "Fatal contact with danger light."}
                      </p>
                    </div>
                    <div className="min-h-0 flex-1 shrink basis-0" aria-hidden />
                  </>
                ) : (
                  <>
                    <div
                      className={`mx-auto mb-4 w-16 h-16 rounded-full flex items-center justify-center ${isWinner ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500"}`}
                    >
                      {isWinner ? <Trophy size={32} /> : <Bomb size={32} />}
                    </div>
                    <h2 className="text-3xl font-black mb-1">
                      {isWinner ? "SESSION COMPLETE" : "TERMINATED"}
                    </h2>
                    <p className="text-neutral-400 text-sm mb-6">
                      {isWinner
                        ? "You survived the full session!"
                        : "Fatal contact with danger light."}
                    </p>
                  </>
                )}

                <div
                  className={`grid grid-cols-2 gap-4 ${verificationSettled ? "mb-3" : "mb-6"}`}
                >
                  <div className="bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                    <div className="text-[10px] uppercase font-bold text-neutral-500">Total XP</div>
                    <div className="text-2xl font-black text-blue-500">{score * XP_PER_HIT}</div>
                  </div>
                  <div className="bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                    <div className="text-[10px] uppercase font-bold text-neutral-500">Hits</div>
                    <div className="text-2xl font-black text-white">{score}</div>
                  </div>
                </div>

                {/* Submitting to server / submit error */}
                {gameState === "FINISHED" && submitMutation.isPending && (
                  <div className="mb-6 w-full rounded-2xl border border-blue-500/20 bg-blue-950/15 p-4 text-left">
                    <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-blue-300 mb-2">
                      <Loader2 className="animate-spin shrink-0" size={16} />
                      Recording session
                    </div>
                    <p className="text-[13px] text-neutral-400 leading-snug">
                      Sending your taps to the server and opening a proof job. Almost there…
                    </p>
                  </div>
                )}
                {gameState === "FINISHED" && submitMutation.isError && (
                  <div className="mb-6 w-full rounded-2xl border border-red-500/30 bg-red-950/20 p-4 text-left">
                    <div className="text-xs font-black uppercase tracking-widest text-red-300 mb-2">
                      Could not submit session
                    </div>
                    <p className="text-[13px] text-red-200/90 leading-relaxed mb-3">
                      {submitMutation.error?.message ??
                        "The server rejected this session. Check the API logs, run `pnpm db:seed`, and ensure Redis is running."}
                    </p>
                    <button
                      type="button"
                      onClick={resetToIdle}
                      className="w-full rounded-full border border-neutral-600 py-2.5 text-xs font-bold text-white hover:bg-neutral-800"
                    >
                      Dismiss and return to menu
                    </button>
                  </div>
                )}

                {/* Background proof verification (before on-chain step) */}
                {verificationPending && (
                  <div className="mb-6 w-full rounded-2xl border border-blue-500/30 bg-linear-to-b from-blue-950/30 to-neutral-950/40 p-5 text-left shadow-[0_0_24px_rgba(59,130,246,0.08)]">
                    <div className="flex items-center gap-2 mb-1">
                      <ShieldCheck className="text-blue-400 shrink-0" size={20} />
                      <span className="text-xs font-black uppercase tracking-widest text-blue-200">
                        Verifying fairness
                      </span>
                    </div>
                    <p className="text-[13px] text-neutral-400 leading-relaxed mb-4">
                      A zero-knowledge proof is being generated and checked in the background (Kurier). When it
                      finishes, you can publish XP on-chain or start a new game—whatever you prefer.
                    </p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800/90 mb-3">
                      <div
                        className="h-full w-2/5 rounded-full bg-blue-500/90"
                        style={{ animation: "verifyBar 2.2s ease-in-out infinite" }}
                      />
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                      <span className="inline-block size-1.5 rounded-full bg-blue-400 animate-pulse" />
                      {verificationLabel}
                    </div>
                  </div>
                )}

                {/* After verification: publish and/or new game (peer choices) */}
                {gameState === "VERIFYING" && verificationSettled && (
                  <div className="flex w-full shrink-0 flex-col animate-in fade-in duration-500">
                    <div className="shrink-0">
                    <div
                      className={`mb-2 rounded-xl border px-3 py-2.5 text-center text-[12px] font-medium leading-snug sm:px-4 sm:text-[13px] ${
                        verificationFullyDone
                          ? "border-green-500/30 bg-green-950/25 text-green-200/95"
                          : verificationFailed
                            ? "border-amber-500/25 bg-amber-950/20 text-amber-100/90"
                            : "border-sky-500/25 bg-sky-950/20 text-sky-100/90"
                      }`}
                    >
                      {verificationFullyDone
                        ? "Proof verification finished — fairness is locked in for this session."
                        : verificationFailed
                          ? "Proof pipeline did not fully succeed, but your session was still recorded. You can publish signed XP or move on to a new game."
                          : "Proof is submitted to Kurier. Deeper checks may still run on-chain; you can publish signed XP or start a new game whenever you are ready."}
                    </div>

                    {!settlement && (
                      <p className="mb-3 text-center text-[11px] text-neutral-500 sm:text-[12px]">
                        Settlement payload is unavailable. You can still start a new game below.
                      </p>
                    )}

                    {settlement && (
                      <p className="mb-0 text-center font-mono text-[10px] text-neutral-500 sm:text-[11px]">
                        {settlement.score} hits · {settlement.xpEarned} XP · {settlement.won ? "survived" : "out"}
                      </p>
                    )}
                    </div>

                    <div className="grid w-full shrink-0 grid-cols-1 items-stretch gap-2 pt-1 sm:grid-cols-2 sm:gap-2 sm:pt-2">
                      <div className="flex flex-col rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-2.5 sm:p-3">
                        <p className="shrink-0 text-center text-[9px] font-bold uppercase tracking-widest text-emerald-400/90 sm:text-[10px]">
                          On-chain (Base Sepolia)
                        </p>
                        <div className="flex flex-col items-center justify-center gap-1.5 pt-1">
                        {!settlement ? (
                          <p className="text-center text-[11px] text-neutral-500">Nothing to publish for this session.</p>
                        ) : !chainTxHash ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void publishToChain()}
                              disabled={
                                isPublishing ||
                                !wallet.address ||
                                !sessionPlayerAddress ||
                                wallet.address.toLowerCase() !== sessionPlayerAddress.toLowerCase()
                              }
                              className="flex w-full items-center justify-center gap-1.5 rounded-full bg-emerald-600 py-2 text-[10px] font-black uppercase tracking-widest text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 sm:py-2.5 sm:text-[11px]"
                            >
                              {isPublishing ? (
                                <>
                                  <Loader2 className="animate-spin" size={16} />
                                  Confirm in wallet…
                                </>
                              ) : (
                                "Publish XP"
                              )}
                            </button>
                            {chainPublishError && (
                              <p className="text-center text-[11px] text-red-400">{chainPublishError}</p>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="text-center text-xs text-emerald-300/90">Published on-chain.</p>
                            <a
                              href={`https://sepolia.basescan.org/tx/${chainTxHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="flex w-full items-center justify-center gap-1.5 rounded-full border border-emerald-600/50 bg-emerald-950/40 py-2 text-[10px] font-bold text-emerald-400 hover:bg-emerald-950/60 sm:text-[11px]"
                            >
                              <ExternalLink size={14} />
                              View on Basescan
                            </a>
                            {onChainStats && (
                              <div className="mt-2 grid w-full grid-cols-2 gap-2 border-t border-emerald-900/40 pt-3 text-center text-[10px]">
                                <div>
                                  <div className="font-bold uppercase text-neutral-500">On-chain XP</div>
                                  <div className="font-mono text-sm text-emerald-400">{onChainStats.totalXP.toString()}</div>
                                </div>
                                <div>
                                  <div className="font-bold uppercase text-neutral-500">Games</div>
                                  <div className="font-mono text-sm text-white">{onChainStats.gamesPlayed.toString()}</div>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={startNewGame}
                        disabled={!wallet.address || newGameMutation.isPending || isPublishing}
                        className="flex flex-col items-center justify-center gap-1 rounded-xl border border-neutral-600 bg-neutral-900/60 px-3 py-2.5 text-center text-[11px] font-black uppercase tracking-widest text-white transition-colors hover:border-blue-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 sm:text-xs"
                      >
                        {newGameMutation.isPending ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          <Play size={16} fill="currentColor" className="text-blue-400" />
                        )}
                        New game
                        <span className="text-[9px] font-normal normal-case tracking-normal text-neutral-500 sm:text-[10px]">
                          Same wallet · new session
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {/* Legend */}
      <div className="mt-10 flex w-full max-w-md flex-col items-center justify-center gap-4 text-neutral-500 sm:mt-12 sm:flex-row sm:flex-wrap sm:gap-x-10 sm:gap-y-2">
        <div className="flex max-w-full items-center gap-2.5 text-xs font-bold uppercase tracking-wide">
          <div className="size-4 shrink-0 rounded bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
          <span className="whitespace-normal text-center sm:whitespace-nowrap">Reward (+{XP_PER_HIT} XP)</span>
        </div>
        <div className="flex max-w-full items-center gap-2.5 text-xs font-bold uppercase tracking-wide">
          <div className="size-4 shrink-0 rounded bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
          <span className="whitespace-normal text-center sm:whitespace-nowrap">Danger (Death)</span>
        </div>
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
    </div>
  );
}
