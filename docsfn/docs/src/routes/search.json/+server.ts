import { createSearchArtifactResponse } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const source = await loadDocsSiteSource();
  return createSearchArtifactResponse({ artifact: source.searchArtifact });
};
