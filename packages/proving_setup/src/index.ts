import { type CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import {
  CircuitKind,
  VerificationStatus,
  type KurierJobStatusResponse,
} from "./types";
import {
  extractAbiParameters,
  loadCircuitAbi,
  uint8ArrayToHex,
  validateAbiInput,
} from "./utils";
import { env } from "@speed-o-light/env/server";
import { createLogger } from "../../api/src/logger";
import fs from "fs";
import path from "path";
import { resolve } from "path";
import { fileURLToPath } from "url";
import axios, { isAxiosError } from "axios";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger("proving-setup");

export async function getRandomSeed(): Promise<string> {
  let seed: string = "";
  try {
    const seedResponse = await axios.post(
      `${env.KURIER_URL}/random-hash/${env.KURIER_API}`,
      {},
    );
    seed = seedResponse.data.hash;
    if (seed) {
      log.info(`[GAME] Seed: ${seed}`);
    }
    return seed;
  } catch (err) {
    if (isAxiosError(err)) {
      log.error(
        "[Game] Kurier random-hash failed:",
        err.response?.status,
        err.response?.data ?? err.message,
      );
    } else {
      log.error("[GAME] Kurier random-hash failed:", err);
    }
    throw err;
  }
}

// setting up Noir and UltraHonk Backend for specific circuit
export function setupProver(circuit_name: CircuitKind) {
  const PATH_TO_CIRCUIT = resolve(
    __dirname,
    `../../circuits/speed_o_light/target/${circuit_name}.json`,
  );

  if (!fs.existsSync(PATH_TO_CIRCUIT)) {
    throw new Error(`[ERR: Circuits] Circuit file not found`);
  }

  const circuit = JSON.parse(fs.readFileSync(PATH_TO_CIRCUIT, "utf8"));
  if (!circuit.bytecode) {
    throw new Error(`[ERR: Circuits] Circuit bytecode not found`);
  }

  log.debug(`## Setting up Prover for ${circuit_name}`);
  const noir = new Noir(circuit as CompiledCircuit);
  const backend = new UltraHonkBackend(circuit.bytecode);
  return { noir, backend };
}

// generating and registering the circuit specific verification key with the zkVerify Kurier relayer
export async function registerVk(circuit_name: CircuitKind) {
  const { backend } = setupProver(circuit_name);
  log.debug(`## Generating Verification Key for ${circuit_name}`);
  const verification_key = await backend.getVerificationKey({ keccak: true });

  const vkey = uint8ArrayToHex(verification_key);
  const VK_HEX_PATH = resolve(
    __dirname,
    `../../circuits/speed_o_light/target/${circuit_name}_vk.hex`,
  );
  fs.writeFileSync(VK_HEX_PATH, vkey);
  if (!fs.existsSync(VK_HEX_PATH)) {
    throw new Error(
      "[ERR: Verification Key] Failed to write verification key hex file",
    );
  }

  const vk_payload = {
    proofType: "ultrahonk",
    proofOptions: {
      variant: "Plain",
    },
    vk: `${vkey}`,
  };

  log.info(`## Registering Verification Key at Kurier for ${circuit_name}`);
  const reg_vk_response = await axios.post(
    `${env.KURIER_URL}/register-vk/${env.KURIER_API}`,
    vk_payload,
  );

  const VK_HASH_PATH = resolve(
    __dirname,
    `../../circuits/speed_o_light/target/${circuit_name}_vkHash.json`,
  );
  fs.writeFileSync(VK_HASH_PATH, JSON.stringify(reg_vk_response.data));
  if (!fs.existsSync(VK_HASH_PATH)) {
    throw new Error(
      "[ERR: Verification Key] Failed to write verification key hash file",
    );
  }
  log.info(`## Verification Key registered successfully for ${circuit_name}`);
}

// generating circuit specific ultrahonk proof with the given inputs
export async function generateProof(
  circuit_name: CircuitKind,
  inputs: Record<string, any>,
): Promise<{ proofHex: string; publicInputs: string[] }> {
  const { noir, backend } = setupProver(circuit_name);

  log.debug(
    `## Extracting parameters and matching inputs for ${circuit_name}`,
  );
  const abi = loadCircuitAbi(circuit_name);
  validateAbiInput(inputs, abi);
  const params = extractAbiParameters(inputs, abi);
  log.debug(`## Creating private witness for ${circuit_name}`);
  const { witness } = await noir.execute(params);

  log.info(`## Generating Proof for ${circuit_name}`);
  const proof_data = await backend.generateProof(witness, {
    keccak: true,
  });

  const proofHex = uint8ArrayToHex(proof_data.proof);

  log.info(`## Verifying Proof w/ BB.js for ${circuit_name}`);
  const is_valid = await backend.verifyProof(proof_data, {
    keccak: true,
  });
  if (!is_valid) {
    throw new Error("[ERR: Proof] Proof verification failed");
  }

  return {
    proofHex,
    publicInputs: proof_data.publicInputs.map((pi) =>
      pi.startsWith("0x") ? pi : `0x${pi}`,
    ),
  };
}

export async function verifyProof(
  circuit_name: CircuitKind,
  proofHex: string,
  formattedPublicInputs: string[],
): Promise<{ jobId: string; optimisticVerify: string }> {
  const VK_HASH_PATH = resolve(
    __dirname,
    `../../circuits/speed_o_light/target/${circuit_name}_vkHash.json`,
  );
  if (!fs.existsSync(VK_HASH_PATH)) {
    log.warn(
      `VK hash not found for ${circuit_name}, registering new VK`,
    );
    await registerVk(circuit_name);
  }
  const vkey = JSON.parse(fs.readFileSync(VK_HASH_PATH, "utf8"));
  const vkHash = vkey.vkHash || vkey.meta.vkHash;
  if (!vkHash) {
    throw new Error("[ERR: ZKV] Verification key not found");
  }
  log.debug(`## vkHash found for ${circuit_name}: ${vkHash}`);
  const proof_payload = {
    proofType: "ultrahonk",
    vkRegistered: true,
    chainId: 84532,
    proofOptions: {
      variant: "Plain",
    },
    proofData: {
      proof: `${proofHex}`,
      publicSignals: formattedPublicInputs,
      vk: vkHash as string,
    },
    submissionMode: "attestation",
  };

  log.info("## Submitting Proof to Kurier");
  const submit_response = await axios.post(
    `${env.KURIER_URL}/submit-proof/${env.KURIER_API}`,
    proof_payload,
  );

  log.debug(
    `Proof response status code for ${circuit_name}:`,
    submit_response.status,
  );

  log.debug(
    `==> Submission Response:\n`,
    JSON.stringify(submit_response.data, null, 2),
  );
  if (submit_response.data.optimisticVerify !== "success") {
    throw new Error("[ERR: Proof Verification] Optimistic verification failed");
  }

  const jobId = submit_response.data.jobId;
  const optimisticVerify = submit_response.data.optimisticVerify;
  log.info(
    `## Proof submitted successfully for ${circuit_name}. Job ID: ${jobId}`,
  );

  return { jobId, optimisticVerify };
}

// ---------------------------------------------------------------------------
// Map from Kurier API status strings → local VerificationStatus enum.
// Kept as a constant so unrecognised values surface immediately at runtime.
// ---------------------------------------------------------------------------
const KURIER_STATUS_MAP: Record<string, VerificationStatus> = {
  Queued: VerificationStatus.QUEUED,
  Valid: VerificationStatus.VALID,
  Submitted: VerificationStatus.SUBMITTED,
  IncludedInBlock: VerificationStatus.INCLUDED_IN_BLOCK,
  Finalized: VerificationStatus.FINALIZED,
  AggregationPending: VerificationStatus.AGGREGATION_PENDING,
  Aggregated: VerificationStatus.AGGREGATED,
  Failed: VerificationStatus.FAILED,
};

/**
 * Query the Kurier relayer for the current status of a verification job.
 *
 * Returns only the fields that map to the `VerificationJob` Prisma model
 * so the API layer can persist them without further transformation.
 *
 * @param jobId — The Kurier job ID returned by `verifyProof()` and stored in the database.
 */
export async function queryKurierStatus(
  jobId: string,
): Promise<KurierJobStatusResponse> {
  const { KURIER_URL, KURIER_API } = process.env;
  if (!KURIER_URL || !KURIER_API) {
    throw new Error("[ERR: Env] Missing environment variables");
  }

  // 1. Query the Kurier relayer for the job's current lifecycle status
  log.debug(`## Querying Kurier job status for jobId: ${jobId}`);
  const job_status_response = await axios.get(
    `${KURIER_URL}/job-status/${KURIER_API}/${jobId}`,
  );

  const data = job_status_response.data;
  log.debug(`==> Kurier status response:\n`, JSON.stringify(data, null, 2));

  // 2. Map the Kurier status string to the local VerificationStatus enum
  const mappedStatus = KURIER_STATUS_MAP[data.status];
  if (!mappedStatus) {
    throw new Error(
      `[ERR: Kurier] Unrecognised verification status "${data.status}" for jobId ${jobId}`,
    );
  }

  // 3. Extract only the fields that correspond to the VerificationJob model.
  //    - txHash:             populated once SUBMITTED or later
  //    - aggregationId:      populated at AGGREGATION_PENDING or later
  //    - aggregationDetails: full aggregation metadata blob (nullable)
  const result: KurierJobStatusResponse = {
    verificationStatus: mappedStatus,
    txHash: data.txHash ?? null,
    aggregationId: data.aggregationId ?? null,
    aggregationDetails: data.aggregationDetails ?? null,
  };

  log.info(`## Kurier job ${jobId} status: ${result.verificationStatus}`);

  return result;
}
