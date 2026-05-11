import { env } from "@speed-o-light/env/server";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";


const pool = new Pool({ connectionString: env.DATABASE_URL! });
const adapter = new PrismaPg(pool);

const globalForPrisma = global as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";

// const res = await pool.query("SELECT 1");
// console.log("DB Connected: ", res.rows);

if ("__dirname" in globalThis) {
  delete (globalThis as any).__dirname;
}
