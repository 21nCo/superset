import { source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { notFound } from "next/navigation";
import { gitConfig } from "@/app/layout.config";
import { Mermaid } from "@/components/mdx/mermaid";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const data = page.data as any;
  const MDX = data.body;

  return (
    <DocsPage
      toc={data.toc}
      full={data.full}
      editOnGithub={{
        owner: gitConfig.user,
        repo: gitConfig.repo,
        path: `searchfn/docs/content/docs/${page.path}`,
        sha: gitConfig.branch,
      }}
    >
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Mermaid }} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const data = page.data as any;
  const docsPath = params.slug?.length ? `/docs/${params.slug.join("/")}` : "/docs";
  const image = "/opengraph-image";

  return {
    title: data.title,
    description: data.description,
    alternates: {
      canonical: docsPath,
    },
    openGraph: {
      title: data.title,
      description: data.description,
      url: docsPath,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: `${data.title} | SearchFn Docs`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: data.title,
      description: data.description,
      images: [image],
    },
  };
}
