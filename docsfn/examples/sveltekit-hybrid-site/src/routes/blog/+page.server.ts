import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const { source } = await parent();

  return {
    posts: Object.values(source.docs.manifest.posts).sort((left, right) =>
      (right.publishedAt ?? right.date).localeCompare(left.publishedAt ?? left.date, "en")
    )
  };
};
