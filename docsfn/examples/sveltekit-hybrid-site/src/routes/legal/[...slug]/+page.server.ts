import { error } from "@sveltejs/kit";
import { getStandalonePageByPath } from "../../../lib/server/site-source";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const slug = Array.isArray(params.slug) ? params.slug.join("/") : params.slug;
  const routePath = `/legal/${slug ?? ""}`.replace(/\/+$/, "");
  const page = getStandalonePageByPath(source.docs.manifest, routePath);

  if (!page) {
    throw error(404, `standalone page ${routePath} was not generated`);
  }

  return {
    page,
    compatPreset: source.docs.compatPreset
  };
};
