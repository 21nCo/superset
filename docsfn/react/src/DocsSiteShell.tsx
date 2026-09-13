import React, { useEffect, type ReactNode } from "react";
import type { DocsTopNavItem } from "@docsfn/core";
import { DocsFooter, type DocsFooterLink } from "./DocsFooter";
import { TopBar, type TopBarItem } from "./TopBar";

export interface DocsSiteShellProps {
  children: ReactNode;
  embedded?: boolean;
  brand?: string;
  brandHref?: string;
  logo?: ReactNode;
  items?: Array<TopBarItem | DocsTopNavItem>;
  searchTrigger?: ReactNode;
  versionSelector?: ReactNode;
  showFooter?: boolean;
  footerNote?: ReactNode;
  footerLinks?: DocsFooterLink[];
  preserveEmbedRoutes?: string[];
  preserveEmbedParams?: string[];
}

export function DocsSiteShell({
  children,
  embedded = false,
  brand = "Documentation",
  brandHref = "/",
  logo,
  items = [],
  searchTrigger,
  versionSelector,
  showFooter = true,
  footerNote = "Built with docsfn",
  footerLinks = [],
  preserveEmbedRoutes = ["/docs", "/blog", "/changelog"],
  preserveEmbedParams = ["showSidebar", "showsidebar", "sidebar"],
}: DocsSiteShellProps) {
  useEffect(() => {
    if (!embedded) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;

      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;

      const rawHref = anchor.getAttribute("href");
      if (!rawHref || rawHref.startsWith("#")) return;

      const currentUrl = new URL(window.location.href);
      const nextUrl = new URL(anchor.href, window.location.href);
      const shouldPreserve =
        nextUrl.origin === window.location.origin &&
        preserveEmbedRoutes.some(
          (route) => nextUrl.pathname === route || nextUrl.pathname.startsWith(`${route}/`)
        );
      if (!shouldPreserve) return;

      nextUrl.searchParams.set("embed", "1");
      for (const param of preserveEmbedParams) {
        const value = currentUrl.searchParams.get(param);
        if (value !== null && !nextUrl.searchParams.has(param)) {
          nextUrl.searchParams.set(param, value);
        }
      }
      anchor.href = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [embedded, preserveEmbedRoutes, preserveEmbedParams]);

  return (
    <div className={`docsfn-site-shell ${embedded ? "docsfn-site-shell--embedded" : ""}`}>
      {!embedded ? (
        <TopBar
          brand={brand}
          brandHref={brandHref}
          logo={logo}
          items={items}
          searchTrigger={searchTrigger}
          versionSelector={versionSelector}
        />
      ) : null}
      <div className="docsfn-site-shell-main">{children}</div>
      {!embedded && showFooter ? <DocsFooter note={footerNote} links={footerLinks} /> : null}
    </div>
  );
}
