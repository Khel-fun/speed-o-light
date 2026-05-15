import { TRPCError } from "@trpc/server";
import { getAddress } from "viem";
import { z } from "zod";
import { prisma } from "@speed-o-light/db";
import { env } from "@speed-o-light/env/server";
import { getRandomSeed } from "@speed-o-light/proving_setup";
import { get_grid_sequence } from "@speed-o-light/proving_setup/speed_o_light/index";
import { signSettlementPayload, type SettlementPayload } from "../lib/settlement_sign";
import { enqueueProof } from "../lib/speed_o_light/proof_queue";
import { publicProcedure, router } from "../index";

const tapSchema = z.object({
  seq_pos: z.string(),
  grid_index: z.string(),
  is_danger: z.boolean(),
  is_tapped: z.boolean(),
});

export const appRouter = router({
  healthCheck: publicProcedure.query(() => "OK"),

  newGame: publicProcedure
    .input(z.object({ playerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }))
    .mutation(async ({ input }) => {
      const playerAddress = getAddress(input.playerAddress);

      await prisma.players.upsert({
        where: { id: playerAddress },
        update: {},
        create: { id: playerAddress, updated_at: new Date() },
      });

      const game = await prisma.games.upsert({
        where: { name: "speed-o-light" },
        update: {},
        create: {
          id: crypto.randomUUID(),
          name: "speed-o-light",
          updated_at: new Date(),
        },
      });

      const { seed, seed_job_id } = await getRandomSeed();
      const rawSeq = await get_grid_sequence(seed);
      const gridSequence = rawSeq.map((tile) => ({
        index: Number(tile.index),
        is_danger: tile.is_danger,
      }));

      const sessionId = crypto.randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.game_sessions.create({
          data: {
            id: sessionId,
            game_id: game.id,
            status: "STARTED",
            updated_at: new Date(),
          },
        });
        await tx.speed_o_light_sessions.create({
          data: {
            id: crypto.randomUUID(),
            session_id: sessionId,
            seed,
            seed_job_id,
            grid_sequence: gridSequence,
            tap_sequence: [],
            updated_at: new Date(),
          },
        });
        await tx.session_players.create({
          data: {
            id: crypto.randomUUID(),
            session_id: sessionId,
            player_address: playerAddress,
            updated_at: new Date(),
          },
        });
      });

      return { sessionId, gridSequence };
    }),

  submitSession: publicProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        playerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        tapSequence: z.array(tapSchema).length(136),
        dangerTap: tapSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const { sessionId, tapSequence, dangerTap } = input;
      const playerAddress = getAddress(input.playerAddress);

      const gameSession = await prisma.game_sessions.findUniqueOrThrow({
        where: { id: sessionId },
        include: { speed_o_light_sessions: true },
      });

      if (gameSession.status === "FINISHED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Session already submitted" });
      }

      const solSession = gameSession.speed_o_light_sessions;
      if (!solSession) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game session not found" });
      }

      const gridSequence = solSession.grid_sequence as { index: number; is_danger: boolean }[];

      for (let i = 0; i < 136; i++) {
        const tap = tapSequence[i];
        const gridCell = gridSequence[i];
        if (!tap || !gridCell) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Missing tap or grid data at position ${i}` });
        }
        if (tap.is_danger !== gridCell.is_danger) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Sequence mismatch at position ${i}`,
          });
        }
      }

      if (dangerTap.seq_pos !== "255") {
        const dangerPos = parseInt(dangerTap.seq_pos, 10);
        if (isNaN(dangerPos) || dangerPos < 0 || dangerPos > 135) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid danger_tap position" });
        }
        const dangerCell = gridSequence[dangerPos];
        if (!dangerCell?.is_danger) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "danger_tap does not reference a danger tile",
          });
        }
      }

      const score = tapSequence.filter((t) => t.is_tapped && !t.is_danger).length;
      const xp = score * 5;
      const isWinner = dangerTap.seq_pos === "255";
      const dangerTapPos = isWinner ? null : parseInt(dangerTap.seq_pos, 10);

      const circuit = await prisma.circuits.findFirst({
        where: {
          circuit_name: "speed_o_light_game_state",
          game_id: gameSession.game_id,
        },
      });
      if (!circuit) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Proof circuit is not in the database for this game. From the repo root run `pnpm db:seed`, then retry.",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.speed_o_light_sessions.update({
          where: { session_id: sessionId },
          data: {
            tap_sequence: tapSequence,
            danger_tap_pos: dangerTapPos,
            score,
            updated_at: new Date(),
          },
        });
        await tx.session_players.update({
          where: {
            session_id_player_address: { session_id: sessionId, player_address: playerAddress },
          },
          data: { xp, is_winner: isWinner, updated_at: new Date() },
        });
        await tx.game_sessions.update({
          where: { id: sessionId },
          data: { status: "FINISHED", updated_at: new Date() },
        });
      });

      try {
        await enqueueProof({
          type: "SOL_GAME_STATE",
          gameId: gameSession.game_id,
          sessionId,
          circuitId: circuit.id,
          seed: solSession.seed,
          tap_sequence: tapSequence,
          danger_tap: dangerTap,
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not queue the proof job. Check that Redis is running and REDIS_URL in apps/server/.env is correct.",
          cause: e,
        });
      }

      let settlement: SettlementPayload;
      try {
        settlement = await signSettlementPayload(env.SIGNING_PRIVATE_KEY, {
          sessionId,
          playerAddress,
          score,
          xpEarned: xp,
          won: isWinner,
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not sign settlement payload. Check SIGNING_PRIVATE_KEY in apps/server/.env.",
          cause: e,
        });
      }

      return { success: true, score, xp, isWinner, settlement };
    }),

  getSessionStatus: publicProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await prisma.game_sessions.findUniqueOrThrow({
        where: { id: input.sessionId },
        include: {
          speed_o_light_sessions: true,
          session_players: { orderBy: { created_at: "asc" } },
          proofs: {
            include: { verification_jobs: true },
            take: 1,
            orderBy: { created_at: "desc" },
          },
        },
      });

      const proof = session.proofs[0] ?? null;
      const vJob = proof?.verification_jobs ?? null;

      const sol = session.speed_o_light_sessions;
      const playerRow = session.session_players[0];
      let settlement: SettlementPayload | null = null;
      if (
        session.status === "FINISHED" &&
        sol &&
        playerRow &&
        /^0x[0-9a-fA-F]{40}$/.test(playerRow.player_address)
      ) {
        settlement = await signSettlementPayload(env.SIGNING_PRIVATE_KEY, {
          sessionId: session.id,
          playerAddress: getAddress(playerRow.player_address as `0x${string}`),
          score: sol.score,
          xpEarned: playerRow.xp,
          won: playerRow.is_winner,
        });
      }

      return {
        sessionStatus: session.status,
        score: session.speed_o_light_sessions?.score ?? 0,
        verificationStatus: vJob?.verification_status ?? null,
        txHash: vJob?.tx_hash ?? null,
        settlement,
      };
    }),
});

export type AppRouter = typeof appRouter;
