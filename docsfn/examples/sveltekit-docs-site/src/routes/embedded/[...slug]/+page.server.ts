import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {
  loadDocsSiteSource,
  type DocsSiteSource,
} from "../../../lib/server/docs-site-source";

export const prerender = false;

export const load: PageServerLoad = async ({ params, parent }) => {
  const parentData = await parent();
  const source =
    "source" in parentData
      ? (parentData.source as DocsSiteSource)
      : await loadDocsSiteSource();
  const slug = params.slug ?? "";
  const normalizedSlug = slug.length > 0 ? slug : "index";

  const embeddedEntry = Object.values(source.manifest.embedded?.pages ?? {}).find(
    (entry) => {
      const candidate = source.manifest.pages[entry.pageId];
      const candidateSlug = candidate?.slug.length ? candidate.slug : "index";
      return candidateSlug === normalizedSlug;
    }
  );
  const page = embeddedEntry ? source.manifest.pages[embeddedEntry.pageId] : undefined;

  if (!page) {
    throw error(404, `embedded page /embedded/${normalizedSlug} was not generated`);
  }

  return {
    page,
    compatPreset: source.compatPreset,
  };
};
