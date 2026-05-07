import { type tap } from "./types";
import { createLogger } from "../../api/src/logger";
import { CircuitKind } from "../src/types";
import { generateProof, verifyProof } from "../src";

const log = createLogger("proof-actions");

export async function generateGameStateProof(
  seed: string,
  tap_sequence: tap[],
  danger_tap: tap
): Promise<{ proofHex: string; publicInputs: string[] }> {
  log.info("[ZK: speed-o-light] initiliazing game state proof gen", { seed, tap_sequence, danger_tap });
  const { proofHex, publicInputs } = await generateProof(
    CircuitKind.SOL_GAME_STATE,
    {seed, tap_sequence, danger_tap},
  );
  log.info("[ZK: speed-o-light] proof generated");
  return { proofHex, publicInputs };
}

export async function submitProof(
  circuitKind: CircuitKind,
  proofHex: string,
  publicInputs: string[]
): Promise<{ jobId: string; optimisticVerify: string }> {
  log.info("[ZK: speed-o-light] verifying & submiting proof to Kurier", { proofHex, publicInputs });
  const { jobId, optimisticVerify } = await verifyProof(
    circuitKind,
    proofHex,
    publicInputs,
  );
  log.info("[ZK: speed-o-light] proof verified and submitted to Kurier", { jobId, optimisticVerify });
  return { jobId, optimisticVerify };
}
