import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "@speed-o-light/env/server";
import { prisma } from "@speed-o-light/db";
import { syncKurierJobToDatabase } from "./kurier_sync";
import { createLogger } from "./../logger";

const log = createLogger("kurier-polling-setup");

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

let workerInstance: Worker | null = null;

export const KURIER_SYNC_QUEUE_NAME = "kurier-status-sync";

// 1. Setup the queue for repeatable jobs
export const kurierSyncQueue = new Queue(KURIER_SYNC_QUEUE_NAME, {
  connection,
});

// 2. Schedule the recurring job every 2 minutes
export async function scheduleKurierSync() {
  log.info("[KURIER-POLLER] cleaning up old repeat jobs");

  // Remove ALL existing repeat jobs before registering a new one
  // const existingJobs = await kurierSyncQueue.getRepeatableJobs();
  const existingJobs = await kurierSyncQueue.getJobSchedulers();
  for (const job of existingJobs) {
    // await kurierSyncQueue.removeRepeatableByKey(job.key);
    await kurierSyncQueue.removeJobScheduler(job.key);
    log.info(`[KURIER-POLLER] removed old job: ${job.key}`);

  }

  log.info(`[KURIER-POLLER] scheduling fresh Kurier sync job`);
  await kurierSyncQueue.add(
    "sync-job",
    {},
    {
      repeat: { every: 120000 },
      jobId: "kurier-sync-repeater",
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
}

// 3. Worker logic
export function initKurierSyncWorker() {
  if (workerInstance) {
    log.info("[KURIER-WORKER] worker already running, skipping init");
    return workerInstance;
  }
  log.info(`[KURIER-WORKER] initializing Kurier sync worker`);

  workerInstance = new Worker(
    KURIER_SYNC_QUEUE_NAME,
    async (job) => {
      log.info(`[KURIER-WORKER] Job ${job.id} started.`);

      // We want to skip jobs that are in terminal states
      const jobsToSync = await prisma.verification_jobs.findMany({
        where: {
          OR: [
            { verification_status: null },
            {
              verification_status: {
                notIn: ["AGGREGATED", "FAILED"], // Terminal states to ignore
              },
            },
          ],
        },
      });

      log.info(
        `[KURIER-WORKER] Found ${jobsToSync.length} jobs to sync.`,
      );

      for (const verificationJob of jobsToSync) {
        try {
          await syncKurierJobToDatabase(verificationJob.kurier_job_id);
        } catch (error) {
          log.error(
            `[KURIER-WORKER] Failed to correctly sync job ${verificationJob.kurier_job_id}`,
            error,
          );
        }
      }

      log.info(`[KURIER-WORKER] Sync cycle completed.`);
    },
    {
      connection,
      concurrency: 1,
      removeOnComplete: { count: 10 }, // keep only last 10 completed jobs
      removeOnFail: { count: 50 }, // keep last 50 failed for debugging
    },
  );

  workerInstance.on("error", (err) => {
    log.error(`[KURIER-WORKER] Uncaught error:`, err);
  });

  return workerInstance;
}

export async function initKurierPoller() {
  await scheduleKurierSync();
  const worker = initKurierSyncWorker(); // returns the singleton
  return worker;
}
