import { getCollectionPosts, resolveEmbedMode } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, url }) => {
  const { source } = await parent();

  return {
    embed: resolveEmbedMode(url),
    collection: source.manifest.collections?.changelog,
    posts: getCollectionPosts("changelog", source.manifest),
  };
};
