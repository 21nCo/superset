import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "$lib", replacement: path.resolve(dirname, "src/lib") },
      { find: "@docsfn/core/search-runtime", replacement: path.resolve(dirname, "../core/src/search-runtime.ts") },
      { find: "@docsfn/core/search", replacement: path.resolve(dirname, "../core/src/search.ts") },
      { find: "@docsfn/core/analytics", replacement: path.resolve(dirname, "../core/src/analytics.ts") },
      { find: "@docsfn/core/browser", replacement: path.resolve(dirname, "../core/src/browser.ts") },
      { find: /^@docsfn\/core$/, replacement: path.resolve(dirname, "../core/src/index.ts") },
      { find: "@docsfn/provider-fs", replacement: path.resolve(dirname, "../provider-fs/src/index.ts") },
      { find: "@docsfn/sveltekit", replacement: path.resolve(dirname, "../sveltekit/src/index.ts") },
      { find: "@searchfn/client", replacement: path.resolve(dirname, "../../searchfn/client/src/index.ts") },
      { find: "@searchfn/core", replacement: path.resolve(dirname, "../../searchfn/core/src/index.ts") },
      { find: "@searchfn/adapter-contracts", replacement: path.resolve(dirname, "../../searchfn/adapter-contracts/src/index.ts") },
      { find: "@searchfn/adapter-memory", replacement: path.resolve(dirname, "../../searchfn/adapter-memory/src/index.ts") },
      { find: "@searchfn/adapter-indexeddb", replacement: path.resolve(dirname, "../../searchfn/adapter-indexeddb/src/index.ts") },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
