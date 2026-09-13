"use client";

import React, { useEffect } from "react";
import type { DocsPageSurface, DocsPageLink } from "./DocsLayout";
import { navigateTo } from "./navigation";

export interface PaginationProps {
  surface?: DocsPageSurface;
  prevPage?: DocsPageLink;
  nextPage?: DocsPageLink;
  sectionContext?: string;
  className?: string;
}

export function Pagination({
  surface,
  prevPage,
  nextPage,
  sectionContext,
  className,
}: PaginationProps) {
  const resolvedPrevPage = prevPage ?? surface?.pagination?.prev;
  const resolvedNextPage = nextPage ?? surface?.pagination?.next;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft" && resolvedPrevPage) {
        navigateTo(resolvedPrevPage.path);
      }
      if (event.altKey && event.key === "ArrowRight" && resolvedNextPage) {
        navigateTo(resolvedNextPage.path);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resolvedPrevPage, resolvedNextPage]);

  if (!resolvedPrevPage && !resolvedNextPage) {
    return null;
  }

  return (
    <nav className={`docsfn-pagination ${className || ""}`} aria-label="Page navigation">
      {sectionContext ? <div className="docsfn-pagination-context">{sectionContext}</div> : null}

      <div className="docsfn-pagination-links">
        {resolvedPrevPage ? (
          <a href={resolvedPrevPage.path} className="docsfn-pagination-prev" rel="prev">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 12L6 8L10 4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <div className="docsfn-pagination-label">Previous</div>
              <div className="docsfn-pagination-title">{resolvedPrevPage.title}</div>
            </div>
          </a>
        ) : (
          <div className="docsfn-pagination-spacer" />
        )}

        {resolvedNextPage ? (
          <a href={resolvedNextPage.path} className="docsfn-pagination-next" rel="next">
            <div>
              <div className="docsfn-pagination-label">Next</div>
              <div className="docsfn-pagination-title">{resolvedNextPage.title}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 4L10 8L6 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        ) : (
          <div className="docsfn-pagination-spacer" />
        )}
      </div>
    </nav>
  );
}
