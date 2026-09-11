import { error } from "@sveltejs/kit";
import { getPostDataOrThrow } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

function isRouteNotFoundError(input: unknown): input is { message: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    String((input as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND"
  );
}

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();

  try {
    return {
      post: getPostDataOrThrow(params.slug, source.docs.manifest),
      compatPreset: source.docs.compatPreset
    };
  } catch (routeError) {
    if (isRouteNotFoundError(routeError)) {
      throw error(404, routeError.message);
    }
    throw routeError;
  }
};
