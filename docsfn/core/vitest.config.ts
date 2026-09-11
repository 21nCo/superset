import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@searchfn/client": resolve(__dirname, "../../searchfn/client/src/index.ts"),
      "@searchfn/core": resolve(__dirname, "../../searchfn/core/src/index.ts"),
      "@searchfn/adapter-contracts": resolve(__dirname, "../../searchfn/adapter-contracts/src/index.ts"),
      "@searchfn/adapter-memory": resolve(__dirname, "../../searchfn/adapter-memory/src/index.ts"),
      "@searchfn/adapter-indexeddb": resolve(__dirname, "../../searchfn/adapter-indexeddb/src/index.ts"),
    },
  },
  test: {
    globals: true,
    testTimeout: 15_000,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.ts", "**/*.config.ts"],
    },
  },
});
