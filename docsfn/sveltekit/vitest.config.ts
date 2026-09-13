import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@docsfn/core": resolve(__dirname, "../core/src/index.ts"),
      "@docsfn/next": resolve(__dirname, "../next/src/index.ts"),
      "@searchfn/client": resolve(__dirname, "../../searchfn/client/src/index.ts"),
      "@searchfn/core": resolve(__dirname, "../../searchfn/core/src/index.ts"),
      "@searchfn/adapter-contracts": resolve(__dirname, "../../searchfn/adapter-contracts/src/index.ts"),
      "@searchfn/adapter-memory": resolve(__dirname, "../../searchfn/adapter-memory/src/index.ts"),
      "@searchfn/adapter-indexeddb": resolve(__dirname, "../../searchfn/adapter-indexeddb/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
