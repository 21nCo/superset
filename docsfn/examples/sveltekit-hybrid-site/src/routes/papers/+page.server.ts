import { getPaperLandingPages } from "../../lib/server/site-source";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const { source } = await parent();

  return {
    papers: getPaperLandingPages(source.papers.manifest)
  };
};
