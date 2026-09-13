import { getCollectionPosts } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const { source } = await parent();

  return {
    posts: getCollectionPosts("blog", source.manifest),
  };
};
