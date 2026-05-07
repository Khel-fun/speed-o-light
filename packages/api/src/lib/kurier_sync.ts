import { prisma } from "@speed-o-light/db";
import { queryKurierStatus } from "@speed-o-light/proving_setup/src/index";
import { VerificationStatus as KurierVerificationStatus } from "@speed-o-light/proving_setup/src/types";
import { createLogger } from "../logger";

const log = createLogger("kurier-db-syncing");

/** Kurier lifecycle values we persist to `VerificationJob` (matches on-chain publish gate + UI). */
const SAVEABLE_PRISMA_STATUSES = new Set([
  "INCLUDED_IN_BLOCK",
  "FINALIZED",
  "AGGREGATION_PENDING",
  "AGGREGATED",
  "FAILED",
]);

const KURIER_TO_PRISMA: Record<KurierVerificationStatus, string> = {
  [KurierVerificationStatus.FAILED]: "FAILED",
  [KurierVerificationStatus.QUEUED]: "QUEUED",
  [KurierVerificationStatus.VALID]: "VALID",
  [KurierVerificationStatus.SUBMITTED]: "SUBMITTED",
  [KurierVerificationStatus.INCLUDED_IN_BLOCK]: "INCLUDED_IN_BLOCK",
  [KurierVerificationStatus.FINALIZED]: "FINALIZED",
  [KurierVerificationStatus.AGGREGATION_PENDING]: "AGGREGATION_PENDING",
  [KurierVerificationStatus.AGGREGATED]: "AGGREGATED",
};

function kurierToPrismaStatus(v: KurierVerificationStatus): string {
  const out = KURIER_TO_PRISMA[v];
  if (!out) throw new Error(`Unknown Kurier verification status: ${String(v)}`);
  return out;
}

/**
 * Pull latest status from Kurier and persist when it reaches a saveable milestone.
 * Safe to call often (e.g. getGame poll); no-ops if Kurier is still behind SUBMITTED.
 */
export async function syncKurierJobToDatabase(kurierJobId: string): Promise<void> {
  try {
    const statusResult = await queryKurierStatus(kurierJobId);
    const prismaStatus = kurierToPrismaStatus(statusResult.verificationStatus);
    if (!SAVEABLE_PRISMA_STATUSES.has(prismaStatus)) return;

    await prisma.verification_jobs.update({
      where: { kurier_job_id: kurierJobId },
      data: {
        verification_status: prismaStatus as any,
        tx_hash: statusResult.txHash,
        aggregation_id: statusResult.aggregationId,
        aggregation_details: (statusResult.aggregationDetails as any) ?? undefined,
      },
    });
  } catch (err) {
    log.error("[KURIER-DB-SYNC] syncing job details to db failed", { kurierJobId, err });
  }
}

export function verificationStatusNeedsKurierPull(
  status: string | null | undefined,
): boolean {
  if (status == null) return true;
  return !["FINALIZED", "AGGREGATED", "FAILED"].includes(status);
}
