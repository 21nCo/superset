import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "docsfn/svelte/vitest.config.ts",
      "docsfn/sveltekit/vitest.config.ts",
      "docsfn/examples/sveltekit-docs-site/vitest.config.ts",
    ],
  },
});
