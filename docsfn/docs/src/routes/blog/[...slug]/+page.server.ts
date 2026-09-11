import { error } from "@sveltejs/kit";
import { getCollectionPostData } from "@docsfn/sveltekit";
import { getCompiledDocsPost } from "$lib/server/docs-site-source";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const post = getCollectionPostData("blog", params.slug, source.manifest);

  if (!post || post.draft) {
    throw error(404, "Post not found");
  }

  const compiled = await getCompiledDocsPost(post.id);

  return {
    post,
    compiled,
    siteTitle: source.siteTitle,
  };
};
