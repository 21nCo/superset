import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const fromExampleRoot = (...segments) => path.resolve(thisDirectory, ...segments);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    prerender: {
      handleMissingId: "warn"
    }
  }
};

export default config;
