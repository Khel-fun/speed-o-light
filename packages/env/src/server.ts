import { config } from "dotenv";
import path from "path";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: resolve(__dirname, "../../../apps/server/.env") });

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    KURIER_URL: z.url(),
    KURIER_API: z.string().min(1),
    KURIER_CHAIN_ID: z.coerce.number().int().positive(),
    SIGNING_PRIVATE_KEY: z.string().min(1),
    REDIS_URL: z.url().default("redis://localhost:6379"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
