import path from "node:path";
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

dotenv.config({
  path: "../../apps/server/.env",
});

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  // Prisma CLI (db push, migrate): use session pooler or direct DB — not transaction pooler :6543.
  datasource: {
    url: env("DIRECT_URL"),
  },
});
