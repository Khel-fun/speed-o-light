import { createContext } from "@speed-o-light/api/context";
import { appRouter } from "@speed-o-light/api/routers/index";
import { env } from "@speed-o-light/env/server";
import { initKurierPoller } from "@speed-o-light/api/lib/kurier_poller";
import { initProofWorker } from "@speed-o-light/api/lib/speed_o_light/proof_queue";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning", "x-trpc-source"],
    credentials: true,
  }),
);

app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

app.listen(3000, async () => {
  const proofWorker = initProofWorker();
  const kurierWorker = await initKurierPoller();

  console.log("Server is running on http://localhost:3000");

  process.on("SIGTERM", async () => {
    console.log("[App] SIGTERM received, shutting down workers...");
    await Promise.all([proofWorker.close(), kurierWorker.close()]);
    process.exit(0);
  });
});
