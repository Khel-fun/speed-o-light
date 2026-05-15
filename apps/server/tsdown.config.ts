import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  format: "esm",
  external: [
      /^@noir-lang\//,
      /^@aztec\//,
    ],
    banner: {
           js: `
                  import { fileURLToPath as __fileURLToPath } from 'url';
                  import { dirname as __dirname_fn } from 'path';
                  const __filename = __fileURLToPath(import.meta.url);
                  const __dirname = __dirname_fn(__filename);
               `
            },
  outDir: "./dist",
  clean: true,
  noExternal: [/@speed-o-light\/.*/],
});
