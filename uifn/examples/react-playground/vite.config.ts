import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@uifn\/core\/primitives\/overlay$/,
        replacement: path.resolve(__dirname, "../../core/dist/primitives/overlay.mjs"),
      },
      {
        find: /^@uifn\/core\/primitives\/(.+)$/,
        replacement: path.resolve(__dirname, "../../core/dist/primitive-entries/$1.mjs"),
      },
      {
        find: /^@uifn\/core\/(.+)$/,
        replacement: path.resolve(__dirname, "../../core/src/$1.ts"),
      },
      {
        find: "@uifn/react",
        replacement: path.resolve(__dirname, "../../react/src/index.ts"),
      },
      {
        find: "@uifn/examples-shared",
        replacement: path.resolve(__dirname, "../shared/src/index.ts"),
      },
      {
        find: "@uifn/core",
        replacement: path.resolve(__dirname, "../../core/src/index.ts"),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 6111,
  },
  preview: {
    host: "127.0.0.1",
    port: 6111,
  },
});
