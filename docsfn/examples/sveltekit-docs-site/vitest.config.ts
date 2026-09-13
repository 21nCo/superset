import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
    }),
  ],
  resolve: {
    conditions: ["browser"],
    alias: [
      { find: "@docsfn/svelte/ApiReferenceRenderer.svelte", replacement: resolve(root, "../../svelte/src/ApiReferenceRenderer.svelte") },
      { find: "@docsfn/svelte/DocsContent.svelte", replacement: resolve(root, "../../svelte/src/DocsContent.svelte") },
      { find: "@docsfn/svelte/EmbeddedPage.svelte", replacement: resolve(root, "../../svelte/src/EmbeddedPage.svelte") },
      { find: "@uifn/svelte", replacement: resolve(root, "../../svelte/src/test-utils/uifn-svelte-stub.ts") },
      { find: "@searchfn/client", replacement: resolve(root, "../../../searchfn/client/src/index.ts") },
      { find: "@searchfn/core", replacement: resolve(root, "../../../searchfn/core/src/index.ts") },
      { find: "@searchfn/adapter-contracts", replacement: resolve(root, "../../../searchfn/adapter-contracts/src/index.ts") },
      { find: "@searchfn/adapter-memory", replacement: resolve(root, "../../../searchfn/adapter-memory/src/index.ts") },
      { find: "@searchfn/adapter-indexeddb", replacement: resolve(root, "../../../searchfn/adapter-indexeddb/src/index.ts") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
