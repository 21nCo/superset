import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    externalDir: true,
  },
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@docsfn/core/browser": path.resolve(dirname, "../../core/src/browser.ts"),
      "@searchfn/client": path.resolve(dirname, "../../../searchfn/client/src/index.ts"),
      "@searchfn/core": path.resolve(dirname, "../../../searchfn/core/src/index.ts"),
      "@searchfn/adapter-contracts": path.resolve(
        dirname,
        "../../../searchfn/adapter-contracts/src/index.ts"
      ),
      "@searchfn/adapter-memory": path.resolve(
        dirname,
        "../../../searchfn/adapter-memory/src/index.ts"
      ),
      "@searchfn/adapter-indexeddb": path.resolve(
        dirname,
        "../../../searchfn/adapter-indexeddb/src/index.ts"
      ),
    };
    return config;
  },
};

export default nextConfig;
