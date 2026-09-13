import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "search-runtime": "src/search-runtime.ts",
    search: "src/search.ts",
    "search-adapter": "src/search-adapter.ts",
    analytics: "src/analytics.ts",
    browser: "src/browser.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
