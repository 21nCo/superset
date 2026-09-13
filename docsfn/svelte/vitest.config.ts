import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess({ script: true }),
    }),
  ],
  resolve: {
    conditions: ["browser"],
    alias: [
      { find: "@uifn/svelte", replacement: resolve(root, "./src/test-utils/uifn-svelte-stub.ts") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
