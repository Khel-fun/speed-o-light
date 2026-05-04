import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_SERVER_URL: z.url(),
    VITE_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    VITE_CHAIN_ID: z.coerce.number().int().positive().default(8453),
  },
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
