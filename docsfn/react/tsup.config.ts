import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/DocsContent.tsx",
    "src/ApiReferenceRenderer.tsx",
    "src/EmbeddedPage.tsx",
    "src/YouTubeEmbed.tsx",
  ],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  onSuccess: async () => {
    await copyFile(path.join(dirname, "src/theme.css"), path.join(dirname, "dist/theme.css"));
    await copyFile(
      path.join(dirname, "src/theme-base.css"),
      path.join(dirname, "dist/theme-base.css")
    );
  },
});
