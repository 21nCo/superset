import type { PageServerLoad } from "./$types";

/** Surface layout `source` on the home route for typed `PageData`. */
export const load: PageServerLoad = async ({ parent }) => {
  return parent();
};
