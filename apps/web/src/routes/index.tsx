import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bomb, Play, RotateCcw, ShieldCheck, Timer, Trophy, Zap } from "lucide-react";
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
type Tap = { seq_pos: string; is_danger: boolean; is_tapped: boolean };
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
  const [gameState, setGameState] = useState<GameState>("IDLE");
  const [playerAddress, setPlayerAddress] = useState("");
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(SESSION_LIMIT);
  const [activeLights, setActiveLights] = useState<ActiveLight[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWinner, setIsWinner] = useState(false);

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
      seq_pos: String(tile.index),
      is_danger: tile.is_danger,
      is_tapped: tapRecord.current[i],
    }));
    const dangerTap: Tap = dangerTapRef.current
      ? { seq_pos: String(dangerTapRef.current.slotIndex), is_danger: true, is_tapped: true }
      : { seq_pos: "255", is_danger: false, is_tapped: false };

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
      setScore((s) => s + XP_PER_HIT);
      aliveRef.current = aliveRef.current.filter((l) => l.slotIndex !== light.slotIndex);
      setActiveLights([...aliveRef.current]);
    },
    [endGame],
  );

  const startNewGame = useCallback(() => {
    const addr = playerAddress.trim();
    if (!addr) return;
    playerAddrRef.current = addr;
    setGameState("STARTING");

    newGameMutation.mutate(
      { playerAddress: addr },
      {
        onSuccess: ({ sessionId: id, gridSequence }) => {
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
  }, [playerAddress, newGameMutation]);

  const resetToIdle = useCallback(() => {
    isPlayingRef.current = false;
    if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    aliveRef.current = [];
    setActiveLights([]);
    setGameState("IDLE");
    setScore(0);
    setTimeLeft(SESSION_LIMIT);
    setSessionId(null);
  }, []);

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
  const verificationDone = verificationStatus === "FINALIZED" || verificationStatus === "AGGREGATED";
  const verificationFailed = verificationStatus === "FAILED";
  const verificationLabel = verificationStatus
    ? (VERIFICATION_LABELS[verificationStatus] ?? "Verifying...")
    : "Generating proof...";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-6 font-sans">

      {/* HUD */}
      <div className="w-full max-w-md flex justify-between items-end mb-6">
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
      <div className="w-full max-w-md h-1.5 bg-neutral-900 rounded-full mb-8 overflow-hidden">
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
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-neutral-950/90 rounded-[2.5rem] backdrop-blur-md border border-neutral-800 p-8 text-center">

            {/* IDLE */}
            {gameState === "IDLE" && (
              <>
                <h1 className="text-4xl font-black italic tracking-tighter mb-2">SPEED-O-LIGHT</h1>
                <p className="text-neutral-400 text-sm mb-6 max-w-[240px]">
                  60s High-Intensity Sprint.<br />Avoid the bombs, harvest the XP.
                </p>
                <input
                  type="text"
                  placeholder="Player address / tag"
                  value={playerAddress}
                  onChange={(e) => setPlayerAddress(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && startNewGame()}
                  className="w-full mb-4 px-4 py-2 rounded-full bg-neutral-800 border border-neutral-700 text-sm text-white placeholder-neutral-500 text-center focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={startNewGame}
                  disabled={!playerAddress.trim() || newGameMutation.isPending}
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
              <div className="animate-in fade-in zoom-in duration-300 w-full">
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

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                    <div className="text-[10px] uppercase font-bold text-neutral-500">Total XP</div>
                    <div className="text-2xl font-black text-blue-500">{score * XP_PER_HIT}</div>
                  </div>
                  <div className="bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                    <div className="text-[10px] uppercase font-bold text-neutral-500">Hits</div>
                    <div className="text-2xl font-black text-white">{score}</div>
                  </div>
                </div>

                {/* Verification status */}
                {gameState === "FINISHED" && (
                  <div className="text-neutral-500 text-[10px] font-bold uppercase tracking-widest animate-pulse mb-4">
                    Submitting session...
                  </div>
                )}
                {gameState === "VERIFYING" && (
                  <div
                    className={`flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest mb-6 ${verificationDone ? "text-green-500" : verificationFailed ? "text-red-400" : "text-neutral-500"}`}
                  >
                    <ShieldCheck size={12} />
                    {verificationLabel}
                  </div>
                )}

                {/* Play again — only available once verification settles or as a bail-out */}
                {gameState === "VERIFYING" && (verificationDone || verificationFailed) && (
                  <button
                    onClick={resetToIdle}
                    className="w-full bg-white text-black font-black px-10 py-3 rounded-full flex items-center justify-center gap-2 transition-transform active:scale-95"
                  >
                    <RotateCcw size={18} /> PLAY AGAIN
                  </button>
                )}
                {gameState === "VERIFYING" && !verificationDone && !verificationFailed && (
                  <button
                    onClick={resetToIdle}
                    className="w-full text-neutral-500 text-xs py-2 underline underline-offset-2 mt-2"
                  >
                    Play again (verification still pending)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-12 flex gap-8 text-neutral-500">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-tighter">
          <div className="w-4 h-4 bg-blue-500 rounded shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
          Reward (+{XP_PER_HIT} XP)
        </div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-tighter">
          <div className="w-4 h-4 bg-red-500 rounded shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
          Danger (Death)
        </div>
      </div>

      <style>{`
        @keyframes shrink {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>
    </div>
  );
}
