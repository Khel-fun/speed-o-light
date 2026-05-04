export enum CircuitKind {
  GAME_STATE = "speed_o_light_game_state",
}

export enum VerificationStatus {
  FAILED = "Failed",
  QUEUED = "Queued",
  VALID = "Valid",
  SUBMITTED = "Submitted",
  INCLUDED_IN_BLOCK = "IncludedInBlock",
  FINALIZED = "Finalized",
  AGGREGATION_PENDING = "AggregationPending",
  AGGREGATED = "Aggregated",
}

export type AggregationDetails = {
  receipt: string;
  receiptBlockHash: string;
  root: string;
  leaf: string;
  leafIndex: number;
  numberOfLeaves: number;
  merkleProof: string[];
};

/**
 * Subset of the Kurier job-status response that maps to the
 * `VerificationJob` Prisma model.
 * Returned by `queryKurierStatus()` so the API layer can persist it.
 */
export interface KurierJobStatusResponse {
  /** Current verification lifecycle status. */
  verificationStatus: VerificationStatus;
  /** On-chain tx hash — populated once SUBMITTED or later. */
  txHash: string | null;
  /** Aggregation batch ID — populated at AGGREGATION_PENDING or later. */
  aggregationId: number | null;
  /** Full aggregation metadata (flexible JSON blob). */
  aggregationDetails: AggregationDetails | null;
}
