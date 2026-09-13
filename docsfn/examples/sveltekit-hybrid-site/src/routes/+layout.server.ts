import { loadHybridSiteSource } from "../lib/server/site-source";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => {
  return {
    source: await loadHybridSiteSource()
  };
};
