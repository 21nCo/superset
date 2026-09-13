import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsDescription,
  DocsTitle,
} from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Mermaid } from "@/components/mdx/mermaid";
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { gitConfig } from "@/app/layout.config";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const data = page.data as any;
  const MDX = data.body;

  return (
    <DocsPage toc={data.toc} full={data.full}
    editOnGithub={{
      owner: gitConfig.user,
      repo: gitConfig.repo,
      path: `datafn/docs/app/docs/${page.path}`,
      sha: gitConfig.branch,
    }}
    >
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription className="mb-0">{data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <LLMCopyButton markdownUrl={`${page.url}.mdx`} />
        <ViewOptions
          markdownUrl={`${page.url}.mdx`}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${page.path}`}
        />
      </div>
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
          alt: `${data.title} | DataFn Docs`,
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
