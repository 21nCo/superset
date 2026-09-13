import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const svelteSrc = path.resolve(dirname, "../svelte/src");
const coreSrc = path.resolve(dirname, "../core/src");
const uifnSvelteSrc = path.resolve(dirname, "../../uifn/svelte/lib/index.ts");
const searchfnRoot = path.resolve(dirname, "../../searchfn");

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: [
      { find: "@docsfn/core/search-runtime", replacement: path.join(coreSrc, "search-runtime.ts") },
      { find: "@docsfn/core/search", replacement: path.join(coreSrc, "search.ts") },
      { find: "@docsfn/core/analytics", replacement: path.join(coreSrc, "analytics.ts") },
      { find: "@docsfn/core/browser", replacement: path.join(coreSrc, "browser.ts") },
      { find: "@uifn/svelte", replacement: uifnSvelteSrc },
      { find: "@searchfn/client", replacement: path.join(searchfnRoot, "client/src/index.ts") },
      { find: "@searchfn/core", replacement: path.join(searchfnRoot, "core/src/index.ts") },
      { find: "@searchfn/adapter-contracts", replacement: path.join(searchfnRoot, "adapter-contracts/src/index.ts") },
      { find: "@searchfn/adapter-memory", replacement: path.join(searchfnRoot, "adapter-memory/src/index.ts") },
      { find: "@searchfn/adapter-indexeddb", replacement: path.join(searchfnRoot, "adapter-indexeddb/src/index.ts") },
      { find: "@site/docs-content", replacement: path.join(svelteSrc, "DocsContent.svelte") },
      { find: "@site/docs-layout", replacement: path.join(svelteSrc, "DocsLayout.svelte") },
      { find: "@site/docs-site-shell", replacement: path.join(svelteSrc, "DocsSiteShell.svelte") },
      { find: "@site/topbar", replacement: path.join(svelteSrc, "TopBar.svelte") },
      { find: "@site/breadcrumbs", replacement: path.join(svelteSrc, "Breadcrumbs.svelte") },
      { find: "@site/pagination", replacement: path.join(svelteSrc, "Pagination.svelte") },
      { find: "@site/docs-sidebar", replacement: path.join(svelteSrc, "DocsSidebar.svelte") },
      { find: "@site/docs-toc", replacement: path.join(svelteSrc, "DocsToc.svelte") },
      { find: "@site/api-reference-renderer", replacement: path.join(svelteSrc, "ApiReferenceRenderer.svelte") },
      { find: "@site/docs-search", replacement: path.join(svelteSrc, "DocsSearch.svelte") },
      { find: "@site/page-actions", replacement: path.join(svelteSrc, "PageActions.svelte") },
      { find: "@site/dated-collection-list", replacement: path.join(svelteSrc, "DatedCollectionList.svelte") },
    ],
  },
});
