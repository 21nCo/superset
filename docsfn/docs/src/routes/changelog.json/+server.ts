import { createDocsCollectionJsonFeedResponse } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async () => {
  const source = await loadDocsSiteSource();

  return createDocsCollectionJsonFeedResponse({
    manifest: source.manifest,
    collectionId: "changelog",
    title: `${source.siteTitle} Changelog`,
    description: "Product updates and release notes.",
  });
};
