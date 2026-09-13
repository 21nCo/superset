import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";

type DocsLayoutProps = Parameters<typeof DocsLayout>[0];

export default function Layout({ children }: { children: DocsLayoutProps["children"] }) {
  const pageTree = source.getPageTree() as Parameters<typeof DocsLayout>[0]["tree"];

  return (
    <DocsLayout
      tree={pageTree}
      {...baseOptions()}
      sidebar={{
        footer: (
          <a
            href="https://21n.co"
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center w-full justify-center gap-2 px-2 pt-6 text-sm text-fd-muted-foreground hover:text-fd-foreground text-center"
          >
            Built at 21n.co
          </a>
        ),
        banner: null,
      }}
    >
      {children}
    </DocsLayout>
  );
}
