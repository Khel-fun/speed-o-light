import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

export async function createContext(opts: CreateExpressContextOptions) {
  return {
    auth: null,
    session: null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
