import { generateRSSFeed } from "@docsfn/core";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const source = await loadDocsSiteSource();
  const collection = source.manifest.collections?.changelog;
  const origin = url.origin;
  const listRoute = collection?.listRoute ?? "/changelog";
  const feedPath = collection?.feedPath ?? `${listRoute}/rss.xml`;
  const changelogLink = `${origin}${listRoute}`;

  const xml = generateRSSFeed(source.manifest, {
    collectionId: "changelog",
    title: `${source.siteTitle} Changelog`,
    description: "Product updates and release notes.",
    link: changelogLink,
    feedHref: `${origin}${feedPath}`,
    itemHref: (post) => `${origin}${post.path}`,
  });

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
};
