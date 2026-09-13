import { defineConfig } from "tsup";

import { mcpfnTestingVersionDefine } from "./version.config.js";

export default defineConfig({
  entry: ["src/index.ts", "src/auth.ts", "src/playwright.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  define: mcpfnTestingVersionDefine,
});
