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
  const post = Object.values(source.manifest.posts).find(
    (candidate) => candidate.collectionId === "blog" && candidate.slug === params.slug
  );

  if (!post) {
    throw error(404, `blog route /blog/${params.slug} was not generated`);
  }

  return {
    post,
    compatPreset: source.compatPreset,
  };
};
