import { generateRSSFeed } from "@docsfn/core";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const source = await loadDocsSiteSource();
  const origin = url.origin;
  const blogLink = `${origin}/blog`;

  const xml = generateRSSFeed(source.manifest, {
    title: `${source.siteTitle} Blog`,
    description: source.config.site.description ?? "Blog posts",
    link: blogLink,
    feedHref: `${blogLink}/rss.xml`,
    itemHref: (post) => `${blogLink}/${post.slug}`,
  });

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
};
