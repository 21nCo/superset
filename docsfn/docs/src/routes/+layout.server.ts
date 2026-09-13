import { resolveEmbedMode, resolveEmbedSidebarMode } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ url }) => {
  const { siteRoot: _siteRoot, ...source } = await loadDocsSiteSource();
  return {
    embed: resolveEmbedMode(url),
    embedSidebar: resolveEmbedSidebarMode(url),
    source,
  };
};
