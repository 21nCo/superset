import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/types.ts",
    "src/capabilities.ts",
    "src/errors.ts",
    "src/relations.ts",
    "src/sort.ts",
    "src/namespace-storage.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2021",
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: "dist",
});
