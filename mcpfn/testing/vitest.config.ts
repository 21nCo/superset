import { defineConfig } from "vitest/config";

import { mcpfnTestingVersionDefine } from "./version.config.js";

export default defineConfig({
  define: mcpfnTestingVersionDefine,
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
