import React, { useState, type ReactNode } from "react";
import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core";
import { Menu, X } from "lucide-react";
import { DocsSidebar } from "./DocsSidebar";
import { DocsToc } from "./DocsToc";

export interface DocsPageLink {
  title: string;
  path: string;
}

export interface DocsPageBreadcrumbItem {
  label: string;
  href: string;
}

export interface DocsPagePagination {
  prev?: DocsPageLink;
  next?: DocsPageLink;
}

export interface DocsPageSurface {
  route: string;
  title?: string;
  description?: string;
  canonicalPath?: string;
  canonicalUrl?: string;
  editLink?: string;
  pageActions?: Array<Record<string, unknown>>;
  sidebar?: Sidebar;
  sidebarId?: string;
  headings?: DocHeading[];
  breadcrumbs?: DocsPageBreadcrumbItem[];
  pagination?: DocsPagePagination;
  topNav?: DocsTopNavItem[];
  versions?: Version[];
  currentVersion?: string;
  versionLinks?: Record<string, string>;
}

export interface DocsLayoutProps {
  children: ReactNode;
  surface?: DocsPageSurface;
  sidebar?: Sidebar;
  headings?: DocHeading[];
  activePath?: string;
  topbar?: ReactNode;
  embedded?: boolean;
}

export function DocsLayout({
  children,
  surface,
  sidebar,
  headings,
  activePath,
  topbar,
  embedded = false,
}: DocsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const resolvedSidebar = sidebar ?? surface?.sidebar;
  const resolvedHeadings = headings ?? surface?.headings ?? [];
  const resolvedActivePath = activePath ?? surface?.route;
  const showSidebar = !embedded && Boolean(resolvedSidebar);
  const showToc = !embedded && resolvedHeadings.length > 0;

  return (
    <div className={`docsfn-layout ${embedded ? "docsfn-layout--embedded" : ""}`}>
      {!embedded && topbar ? <div className="docsfn-layout-topbar">{topbar}</div> : null}

      {showSidebar ? (
        <div className="docsfn-mobile-toolbar">
          <button
            type="button"
            className="docsfn-mobile-menu-btn"
            aria-expanded={sidebarOpen}
            aria-controls="docsfn-sidebar-panel"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <X size={17} strokeWidth={1.8} /> : <Menu size={17} strokeWidth={1.8} />}
            {sidebarOpen ? "Close" : "Menu"}
          </button>
        </div>
      ) : null}

      {sidebarOpen ? (
        <button
          type="button"
          className="docsfn-mobile-backdrop"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="docsfn-container">
        {showSidebar && resolvedSidebar ? (
          <aside
            id="docsfn-sidebar-panel"
            className={`docsfn-sidebar-col ${sidebarOpen ? "docsfn-sidebar-col--open" : ""}`}
          >
            <DocsSidebar
              surface={surface}
              sidebar={resolvedSidebar}
              activePath={resolvedActivePath}
            />
          </aside>
        ) : null}

        <main className="docsfn-main">{children}</main>

        {showToc ? (
          <aside className="docsfn-toc-col">
            <DocsToc surface={surface} headings={resolvedHeadings} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
