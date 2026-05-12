import { CircuitKind } from "./types";
import { circuitJsonPath } from "@speed-o-light/circuits";
import type { AbiParameter } from "@noir-lang/types";
import fs from "fs";

interface CircuitAbi {
  parameters: AbiParameter[];
  return_type: any;
  error_types: Record<string, any>;
}

interface CircuitJson {
  noir_version: string;
  hash: string;
  abi: CircuitAbi;
  bytecode: string;
  debug_symbols: string;
  file_map: Record<string, any>;
  names: string[];
  brillig_names: string[];
}

export function uint8ArrayToHex(buffer: Uint8Array): string {
  const hex: string[] = [];

  buffer.forEach(function (i) {
    let h = i.toString(16);
    if (h.length % 2) {
      h = "0" + h;
    }
    hex.push(h);
  });

  return "0x" + hex.join("");
}

export function hexToUint8Array(hex: string): Uint8Array {
  const sanitisedHex = BigInt(hex).toString(16).padStart(64, "0");

  const len = sanitisedHex.length / 2;
  const u8 = new Uint8Array(len);

  let i = 0;
  let j = 0;
  while (i < len) {
    u8[i] = parseInt(sanitisedHex.slice(j, j + 2), 16);
    i += 1;
    j += 2;
  }

  return u8;
}

export function loadCircuitAbi(circuit_name: CircuitKind): CircuitAbi {
  const circuitPath = circuitJsonPath(circuit_name);

  if (!fs.existsSync(circuitPath)) {
    throw new Error(`[ERR: Circuit] Circuit file not found`);
  }

  const circuitData: CircuitJson = JSON.parse(
    fs.readFileSync(circuitPath, "utf-8"),
  );
  if (!circuitData.abi) {
    throw new Error(`[ERR: Circuit] Circuit ABI not found`);
  }

  return circuitData.abi;
}

export function extractAbiParameters(
  input: any,
  abi: CircuitAbi,
): Record<string, any> {
  const extractedParams: Record<string, any> = {};

  for (const param of abi.parameters) {
    if (!(param.name in input)) {
      throw new Error(
        `[ERR: Circuit] Missing required parameter: ${param.name} (${param.visibility})`,
      );
    }
    extractedParams[param.name] = input[param.name];
  }

  return extractedParams;
}

export function validateAbiInput(input: any, abi: CircuitAbi): void {
  if (typeof input !== "object" || input === null) {
    throw new Error("Input must be an object");
  }

  const requiredParams = abi.parameters.map((p) => p.name);
  const providedParams = Object.keys(input);

  const missing = requiredParams.filter((p) => !providedParams.includes(p));

  if (missing.length > 0) {
    throw new Error(
      `[ERR: Circuit] Missing required circuit input parameters: ${missing.join(", ")}`,
    );
  }
}
