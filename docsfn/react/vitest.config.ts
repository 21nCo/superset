import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@uifn/react", replacement: resolve(root, "./src/test-utils/uifn-react-stub.tsx") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
