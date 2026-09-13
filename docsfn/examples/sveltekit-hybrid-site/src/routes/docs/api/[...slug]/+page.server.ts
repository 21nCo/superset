import { flattenSidebarLinks } from "@docsfn/core";
import { loadApiData } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const api = loadApiData(params.slug, source.docs.manifest, {
    basePath: source.docs.basePath
  });

  return {
    api,
    apiLinks: Object.values(source.docs.manifest.apis)
      .sort((left, right) => left.path.localeCompare(right.path, "en"))
      .map((entry) => ({
        title: entry.title,
        path: entry.path
      }))
  };
};
