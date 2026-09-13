import { getCollectionPosts } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "./$types";

function redirectWithSearch(path: string, url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${path}${url.search}`,
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}

export const GET: RequestHandler = async ({ url }) => {
  const source = await loadDocsSiteSource();
  const latest = getCollectionPosts("changelog", source.manifest)[0];

  if (!latest) {
    return new Response("No changelog entries found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }

  if (latest.path === url.pathname) {
    return new Response("The changelog slug 'latest' is reserved for the latest-entry alias", {
      status: 409,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }

  return redirectWithSearch(latest.path, url);
};
