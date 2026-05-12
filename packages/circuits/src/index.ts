import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_DIR = path.resolve(__dirname, "../speed_o_light/target");

export const circuitsTargetDir = TARGET_DIR;

export function circuitJsonPath(circuitName: string): string {
  return path.join(TARGET_DIR, `${circuitName}.json`);
}

export function vkHexPath(circuitName: string): string {
  return path.join(TARGET_DIR, `${circuitName}_vk.hex`);
}

export function vkHashPath(circuitName: string): string {
  return path.join(TARGET_DIR, `${circuitName}_vkHash.json`);
}
