import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("Seeding database...");

  // 1. Create or ensure Game exists
  const game = await prisma.games.upsert({
    where: { name: "speed-o-light" },
    update: {},
    create: {
      id: crypto.randomUUID(),
      name: "speed-o-light",
      updated_at: new Date(),
    },
  });
  console.log(`[db] Game initialized: ${game.name} (${game.id})`);

  // 2. Locate the circuits targets directory
  const targetDir = path.resolve(__dirname, "../../circuits/speed_o_light/target");

  const circuitsToSeed = ["speed_o_light_game_state"];

  for (const circuitName of circuitsToSeed) {
    console.log(`[db] Processing ${circuitName}...`);

    try {
      const jsonContent = await fs.readFile(path.join(targetDir, `${circuitName}.json`), "utf8");
      const compiledCircuit = JSON.parse(jsonContent);

      const vkHexContent = await fs.readFile(path.join(targetDir, `${circuitName}_vk.hex`), "utf8");

      const vkHashContent = await fs.readFile(path.join(targetDir, `${circuitName}_vkHash.json`), "utf8");
      const vkHashObj = JSON.parse(vkHashContent);
      const vkHash = vkHashObj.vkHash || vkHashObj.meta?.vkHash;

      if (!vkHash) {
        throw new Error(`vkHash not found in ${circuitName}_vkHash.json`);
      }

      // Check if circuit already exists (no @unique constraint on gameId/circuitName so findFirst is used)
      const existingCircuit = await prisma.circuits.findFirst({
        where: { game_id: game.id, circuit_name: circuitName },
      });

      if (existingCircuit) {
        // Update
        await prisma.circuits.update({
          where: { id: existingCircuit.id },
          data: {
            compiled_circuit: compiledCircuit,
            verification_key: vkHexContent.trim(),
            vk_hash: vkHash,
            updated_at: new Date(),
          },
        });
        console.log(`[db] Updated circuit: ${circuitName}`);
      } else {
        // Create
        await prisma.circuits.create({
          data: {
            id: crypto.randomUUID(),
            game_id: game.id,
            circuit_name: circuitName,
            compiled_circuit: compiledCircuit,
            verification_key: vkHexContent.trim(),
            vk_hash: vkHash,
            updated_at: new Date(),
          },
        });
        console.log(`[db] Created circuit: ${circuitName}`);
      }
    } catch (e: any) {
      console.warn(`[db] Skipping circuit ${circuitName}. Error: ${e.message}`);
    }
  }

  console.log("Seeding complete.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
