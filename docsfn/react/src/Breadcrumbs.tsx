import React from "react";
import type { DocsPageSurface } from "./DocsLayout";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  surface?: DocsPageSurface;
  items?: BreadcrumbItem[];
  separator?: React.ReactNode;
  className?: string;
}

function resolveItems(surface?: DocsPageSurface, explicitItems?: BreadcrumbItem[]): BreadcrumbItem[] {
  if (Array.isArray(explicitItems) && explicitItems.length > 0) {
    return explicitItems;
  }
  if (Array.isArray(surface?.breadcrumbs) && surface.breadcrumbs.length > 0) {
    return surface.breadcrumbs.map((item) => ({
      label: item.label,
      href: item.href,
    }));
  }
  return [];
}

export function Breadcrumbs({ surface, items, separator, className }: BreadcrumbsProps) {
  const resolvedItems = resolveItems(surface, items);
  if (resolvedItems.length === 0) {
    return null;
  }

  const defaultSeparator = (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="docsfn-breadcrumb-separator"
    >
      <path
        d="M6 4L10 8L6 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <nav className={`docsfn-breadcrumbs ${className || ""}`} aria-label="Breadcrumb">
      <ol className="docsfn-breadcrumbs-list">
        {resolvedItems.map((item, index) => {
          const isLast = index === resolvedItems.length - 1;

          return (
            <li key={`${item.label}:${index}`} className="docsfn-breadcrumb-item">
              {item.href && !isLast ? (
                <a href={item.href} className="docsfn-breadcrumb-link">
                  {item.label}
                </a>
              ) : (
                <span className="docsfn-breadcrumb-current" aria-current={isLast ? "page" : undefined}>
                  {item.label}
                </span>
              )}

              {!isLast ? (
                <span className="docsfn-breadcrumb-separator-wrapper">
                  {separator || defaultSeparator}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
