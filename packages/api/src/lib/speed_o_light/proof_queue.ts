import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { prisma } from "@speed-o-light/db";
import { env } from "@speed-o-light/env/server";
import { generateGameStateProof, submitProof } from "@speed-o-light/proving_setup/speed_o_light/proving";
import type { tap } from "@speed-o-light/proving_setup/speed_o_light/types";
import { CircuitKind } from "@speed-o-light/proving_setup";
import { syncKurierJobToDatabase } from "../kurier_sync";
import { createLogger } from "../../logger";

const log = createLogger("speed-o-light-proof-queue");

// ---------------------------------------------------------------------------
// 1. Connection & Types
// ---------------------------------------------------------------------------
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export type ProofJobData = {
  type: "SOL_GAME_STATE";
  gameId: string;
  sessionId: string;
  circuitId: string;
  seed: string;
  tap_sequence: tap[];
  danger_tap: tap;
  // Checkpoint fields — persisted after proof generation so retries skip it
  proofHex?: string;
  publicInputs?: string[];
}

// ---------------------------------------------------------------------------
// 2. Queue Setup
// ---------------------------------------------------------------------------
export const PROOF_QUEUE_NAME = "speed-o-light zk proof";
export const proofQueue = new Queue<ProofJobData>(PROOF_QUEUE_NAME, {
  connection,
});
/**
 * Helper to safely enqueue a proof generation job.
 * Uses jobId for idempotency (prevents duplicate jobs for the same game+type).
 */
export async function enqueueProof(data: ProofJobData) {
  const jobId = `${data.sessionId}-${data.type}`;
  log.info(`[PROOF_Q] Enqueuing ${data.type} proof for game-session: ${data.sessionId}`);
  log.info(`[PROOF_Q] job: ${jobId}`);

  await proofQueue.add(data.type, data, {
    jobId, // ensure we don't queue multiple of the same proof
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 }, // 5s, 10s, 20s...
    removeOnComplete: true,
    removeOnFail: { count: 100 }, // keep last 100 failed for debugging
  });
}

// ---------------------------------------------------------------------------
// 3. Worker Setup
// ---------------------------------------------------------------------------

let proofWorkerInstance: Worker<ProofJobData> | null = null;
export function initProofWorker() {
  if (proofWorkerInstance) {
    log.info("[PROOF_WORKER] Proof worker already running, skipping init");
    return proofWorkerInstance;
  }

  log.info(`[PROOF_WORKER] Initializing proof worker (Concurrency: 1)`);

  proofWorkerInstance = new Worker<ProofJobData>(
    PROOF_QUEUE_NAME,
    async (job: Job<ProofJobData>) => {
      const data = job.data;
      log.info(`[PROOF_WORKER] Started processing job: ${job.id}`);

      if( data.type === "SOL_GAME_STATE") {
        return processGameStateProof(job);
      } else {
        throw new Error(`[Worker] Unknown job type: ${(data as any).type}`);
      }
    },
    {
      connection,
      concurrency: 1, // Proof generation is CPU-heavy, process one at a time per worker instance
    },
  );

  // Observability
  proofWorkerInstance.on("completed", (job) => {
    log.info(`[PROOF_WORKER] Job ${job.id} has completed successfully!`);
  });

  proofWorkerInstance.on("failed", (job, err) => {
    log.error(
      `[PROOF_WORKER] Job ${job?.id} has failed with error:`,
      err.message,
    );
  });

  proofWorkerInstance.on("error", (err) => {
    log.error(`[PROOF_WORKER] Uncaught worker error:`, err);
  });

  return proofWorkerInstance;
}

// ---------------------------------------------------------------------------
// 4. Job Processors
// ---------------------------------------------------------------------------

async function attachProofPlayers(proofId: string, sessionId: string) {
  const sessionPlayers = await prisma.session_players.findMany({
    where: { session_id: sessionId },
    select: { player_address: true },
  });
  if (sessionPlayers.length === 0) return;
  await prisma.proof_players.createMany({
    data: sessionPlayers.map((sp) => ({
      id: crypto.randomUUID(),
      proof_id: proofId,
      player_address: sp.player_address,
    })),
    skipDuplicates: true,
  });
}

export async function processGameStateProof(job: Job<ProofJobData>) {
  const data = job.data;
  const maxAttempts = job.opts.attempts ?? 1;

  try {
    // ---------------------------------------------------------------------------
    // Step 1: Generate proof — skipped on retry if checkpoint already set
    // ---------------------------------------------------------------------------
    let { proofHex, publicInputs } = data;
    if (!proofHex || !publicInputs) {
      log.info(`[PROOF_WORKER] Generating proof for session: ${data.sessionId}`);
      ({ proofHex, publicInputs } = await generateGameStateProof(
        data.seed,
        data.tap_sequence,
        data.danger_tap,
      ));
      // Persist checkpoint: future retries skip proof generation entirely
      await job.updateData({ ...data, proofHex, publicInputs });
      log.info(`[PROOF_WORKER] Proof generated and checkpointed for session: ${data.sessionId}`);
    } else {
      log.info(`[PROOF_WORKER] Proof checkpoint found — skipping generation for session: ${data.sessionId}`);
    }

    // ---------------------------------------------------------------------------
    // Step 2: Persist proof record — idempotent (session may already have one from a prior attempt)
    // ---------------------------------------------------------------------------
    let proof = await prisma.proofs.findFirst({ where: { session_id: data.sessionId } });
    if (!proof) {
      proof = await prisma.proofs.create({
        data: {
          id: crypto.randomUUID(),
          game_id: data.gameId,
          session_id: data.sessionId,
          circuit_id: data.circuitId,
          bb_verification_status: true,
          updated_at: new Date(),
        },
      });
      await attachProofPlayers(proof.id, data.sessionId);
    }

    // ---------------------------------------------------------------------------
    // Step 3: Submit to Kurier — the step most likely to fail transiently
    // ---------------------------------------------------------------------------
    const { jobId, optimisticVerify } = await submitProof(
      CircuitKind.SOL_GAME_STATE,
      proofHex,
      publicInputs,
    );

    await prisma.$transaction(async (tx) => {
      await tx.proofs.update({
        where: { id: proof.id },
        data: { kurier_job_id: jobId },
      });
      await tx.verification_jobs.create({
        data: {
          kurier_job_id: jobId,
          optimistic_verify: optimisticVerify === "success",
          verification_status:
            optimisticVerify === "success" ? "SUBMITTED" : "FAILED",
          updated_at: new Date(),
        },
      });
    });

    await syncKurierJobToDatabase(jobId);

    // Success — wipe sensitive fields now that the job is fully done
    await job.updateData({ ...job.data, seed: "", tap_sequence: [], proofHex: undefined, publicInputs: undefined });

  } catch (err) {
    log.error(`[PROOF_WORKER] Job failed for session ${data.sessionId} (attempt ${job.attemptsMade}/${maxAttempts}):`, err);

    // Only wipe checkpoint on the final attempt — intermediate failures must preserve it
    if (job.attemptsMade >= maxAttempts) {
      await job.updateData({ ...job.data, seed: "", tap_sequence: [], proofHex: undefined, publicInputs: undefined });
    }

    throw err;
  }
}
