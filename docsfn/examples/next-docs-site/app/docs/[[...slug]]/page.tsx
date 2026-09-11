import { compileReactContent, resolveMarkdownRelativeLinks } from "@docsfn/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  generatePageMetadata,
  generateStaticParams as generateDocsStaticParams,
  resolveDocsPageSurface,
  resolveDocsRouteData,
} from "@docsfn/next";
import { ApiReferenceRenderer } from "@docsfn/react/ApiReferenceRenderer";
import { DocsContent } from "@docsfn/react/DocsContent";
import { loadDocsSiteSource } from "@/source.config";
import { SearchArtifactStatus } from "../SearchArtifactStatus";

type DocsPageParams = {
  slug?: string[];
};

type SidebarItem = {
  type: "link" | "group" | "separator";
  text: string;
  link?: string;
  items?: SidebarItem[];
};

function renderSidebarItems(items: SidebarItem[], depth = 0): ReactNode {
  return (
    <ul className="docs-example-sidebar-list" data-depth={depth}>
      {items.map((item, index) => {
        if (item.type === "separator") {
          return <li key={`separator-${depth}-${index}`} className="docs-example-separator" />;
        }

        if (item.type === "group") {
          return (
            <li key={`group-${depth}-${index}`}>
              <span className="docs-example-group-label">{item.text}</span>
              {Array.isArray(item.items) && item.items.length > 0
                ? renderSidebarItems(item.items, depth + 1)
                : null}
            </li>
          );
        }

        return (
          <li key={`link-${depth}-${index}`}>
            <a href={item.link} className="docs-example-sidebar-link">
              {item.text}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export async function generateStaticParams() {
  const source = await loadDocsSiteSource();
  return generateDocsStaticParams(source.manifest, {
    basePath: "/docs",
    includeApiRoutes: true,
  });
}

export async function generateMetadata(props: {
  params: Promise<DocsPageParams>;
}): Promise<Metadata> {
  const params = await props.params;
  const source = await loadDocsSiteSource();
  const routeEntry = resolveDocsRouteData(params.slug, source.manifest, {
    basePath: "/docs",
  });

  if (!routeEntry) {
    return {};
  }

  if (routeEntry.kind === "page") {
    const metadata = generatePageMetadata(routeEntry.page, {
      siteTitle: source.siteTitle,
      canonicalUrl: source.canonicalUrl,
    });

    return {
      title: metadata.title,
      description: metadata.description,
      alternates: {
        canonical: metadata.alternates.canonical,
      },
      openGraph: {
        title: metadata.openGraph.title,
        description: metadata.openGraph.description,
        url: metadata.openGraph.url,
      },
    };
  }

  if (routeEntry.kind === "api") {
    const apiDescription =
      typeof routeEntry.api.spec === "object" &&
      routeEntry.api.spec !== null &&
      "info" in routeEntry.api.spec &&
      typeof (routeEntry.api.spec as { info?: { description?: unknown } }).info?.description ===
        "string"
        ? ((routeEntry.api.spec as { info: { description: string } }).info.description as string)
        : `API reference for ${routeEntry.api.title}`;
    const canonical = source.canonicalUrl
      ? `${source.canonicalUrl.replace(/\/+$/, "")}${routeEntry.api.path}`
      : routeEntry.api.path;

    return {
      title: `${routeEntry.api.title} | ${source.siteTitle}`,
      description: apiDescription,
      alternates: {
        canonical,
      },
      openGraph: {
        title: routeEntry.api.title,
        description: apiDescription,
        url: canonical,
      },
    };
  }

  return {};
}

export default async function DocsPage(props: {
  params: Promise<DocsPageParams>;
}) {
  const params = await props.params;
  const source = await loadDocsSiteSource();
  const routeEntry = resolveDocsRouteData(params.slug, source.manifest, {
    basePath: "/docs",
  });

  if (!routeEntry || routeEntry.kind === "post") {
    notFound();
  }

  const surface = resolveDocsPageSurface({
    manifest: source.manifest,
    route: routeEntry.route,
    page: routeEntry.kind === "page" ? routeEntry.page : undefined,
    options: {
      basePath: "/docs",
      homeHref: "/docs",
      canonicalUrl: source.canonicalUrl,
      versionMode: "path-prefix",
    },
  });

  const sidebar = surface.sidebarId ? source.manifest.sidebars[surface.sidebarId] : undefined;

  return (
    <div className="docs-example-grid">
      <aside className="docs-example-sidebar">
        <h2>Navigation</h2>
        {sidebar ? renderSidebarItems(sidebar.items as SidebarItem[]) : <p>No sidebar</p>}
      </aside>

      <main className="docs-example-main">
        <header className="docs-example-topbar">
          <nav>
            <ul className="docs-example-topnav">
              {(surface.topNav ?? []).map((item) => (
                <li key={`${item.label}:${item.href}`}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <p className="docs-example-search-status" data-docsfn-search-runtime="true">
            Search ready: {source.searchProbe.resultCount} hits for &ldquo;
            {source.searchProbe.query}
            &rdquo; ({source.searchProbe.scopes.join(", ")})
            {source.searchProbe.firstPath ? ` -> ${source.searchProbe.firstPath}` : ""}
          </p>
          <SearchArtifactStatus />
        </header>

        <nav aria-label="Breadcrumb">
          <ol className="docs-example-breadcrumbs">
            {(surface.breadcrumbs ?? []).map((crumb) => (
              <li key={`${crumb.label}:${crumb.href}`}>
                <a href={crumb.href}>{crumb.label}</a>
              </li>
            ))}
          </ol>
        </nav>

        {surface.versionLinks ? (
          <div className="docs-example-versions">
            <span>Versions:</span>
            {Object.entries(surface.versionLinks).map(([slug, href]) => (
              <a key={slug} href={href} className={slug === surface.currentVersion ? "active" : ""}>
                {slug}
              </a>
            ))}
          </div>
        ) : null}

        {routeEntry.kind === "page" ? (
          <article className="docs-example-article" data-docsfn-proof-surface="docs">
            <h1>{routeEntry.page.title}</h1>
            {routeEntry.page.description ? <p>{routeEntry.page.description}</p> : null}

            {(surface.headings ?? []).length > 0 ? (
              <section>
                <h2>On this page</h2>
                <ul className="docs-example-toc">
                  {(surface.headings ?? []).map((heading) => (
                    <li key={heading.slug}>
                      <a href={`#${heading.slug}`}>{heading.text}</a>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <DocsContent
              compiled={resolveMarkdownRelativeLinks({
                compiled: compileReactContent({ source: routeEntry.page.body, sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""), compatPreset: source.compatPreset }),
                route: routeEntry.route, sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""),
              })}
            />
          </article>
        ) : (
          <article className="docs-example-article" data-docsfn-proof-surface="api">
            <h1>{routeEntry.api.title}</h1>
            <p>Route: {routeEntry.api.path}</p>
            <ApiReferenceRenderer api={routeEntry.api} />
          </article>
        )}

        {surface.pagination && (surface.pagination.prev || surface.pagination.next) ? (
          <nav className="docs-example-pagination" aria-label="Pagination">
            {surface.pagination.prev ? (
              <a href={surface.pagination.prev.path}>Previous: {surface.pagination.prev.title}</a>
            ) : (
              <span />
            )}
            {surface.pagination.next ? (
              <a href={surface.pagination.next.path}>Next: {surface.pagination.next.title}</a>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </main>
    </div>
  );
}
