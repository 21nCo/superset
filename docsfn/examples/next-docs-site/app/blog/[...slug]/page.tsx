import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { generateDocsBlogParams, getDocsBlogPostData } from "@docsfn/next";
import { DocsContent } from "@docsfn/react/DocsContent";
import { loadDocsSiteSource } from "@/source.config";

type BlogPageParams = {
  slug: string[];
};

export async function generateStaticParams() {
  const source = await loadDocsSiteSource();
  return generateDocsBlogParams(source.manifest, { catchAll: true });
}

export async function generateMetadata(props: {
  params: Promise<BlogPageParams>;
}): Promise<Metadata> {
  const params = await props.params;
  const source = await loadDocsSiteSource();
  const post = getDocsBlogPostData(params.slug, source.manifest);
  if (!post) {
    return {};
  }

  const canonical = source.canonicalUrl
    ? `${source.canonicalUrl.replace(/\/+$/, "")}${post.path}`
    : post.path;

  return {
    title: `${post.title} | ${source.siteTitle}`,
    description: post.excerpt ?? post.summary ?? post.title,
    alternates: {
      canonical,
    },
    openGraph: {
      title: post.title,
      description: post.excerpt ?? post.summary ?? post.title,
      url: canonical,
    },
  };
}

export default async function BlogPostPage(props: {
  params: Promise<BlogPageParams>;
}) {
  const params = await props.params;
  const source = await loadDocsSiteSource();
  const post = getDocsBlogPostData(params.slug, source.manifest);
  if (!post) {
    notFound();
  }

  return (
    <article
      className="docs-example-article"
      data-docsfn-blog-post="true"
      data-docsfn-proof-surface="blog"
    >
      <h1>{post.title}</h1>
      <p>{new Date(post.publishedAt ?? post.date).toUTCString()}</p>
      {post.author ? <p>By {post.author}</p> : null}
      {post.excerpt ?? post.summary ? <p>{post.excerpt ?? post.summary}</p> : null}
      {post.tags.length > 0 ? (
        <p>
          Tags: {post.tags.join(", ")}
        </p>
      ) : null}
      <DocsContent
        content={post.body}
        sourcePath={post.id}
        compatPreset={source.compatPreset}
      />
    </article>
  );
}
