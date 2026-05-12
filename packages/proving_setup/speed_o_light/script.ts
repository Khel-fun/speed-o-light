import { registerVk } from "../src";
import { CircuitKind } from "../src";

async function main() {
  console.log("Registering VK for SOL_GAME_STATE...");
  await registerVk(CircuitKind.SOL_GAME_STATE);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
