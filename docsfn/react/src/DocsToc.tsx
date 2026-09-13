"use client";

import React, { useEffect, useState } from "react";
import type { DocHeading } from "@docsfn/core";
import { ScrollArea, ScrollAreaViewport } from "@uifn/react";
import type { DocsPageSurface } from "./DocsLayout";

export interface DocsTocProps {
  surface?: DocsPageSurface;
  headings?: DocHeading[];
  activeHash?: string;
}

export function DocsToc({ surface, headings, activeHash: activeHashProp }: DocsTocProps) {
  const resolvedHeadings = headings ?? surface?.headings ?? [];
  const [activeHash, setActiveHash] = useState(activeHashProp || "");

  useEffect(() => {
    if (activeHashProp !== undefined) {
      setActiveHash(activeHashProp);
      return;
    }

    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const id = entry.target.getAttribute("id");
          if (id) {
            setActiveHash(`#${id}`);
            break; // first (topmost) intersecting heading wins
          }
        }
      },
      {
        rootMargin: "-80px 0px -80% 0px",
        threshold: 0,
      }
    );

    for (const heading of resolvedHeadings) {
      const element = document.getElementById(heading.slug);
      if (element) {
        observer.observe(element);
      }
    }

    return () => observer.disconnect();
  }, [resolvedHeadings, activeHashProp]);

  if (resolvedHeadings.length === 0) {
    return null;
  }

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
    if (typeof window === "undefined") {
      return;
    }

    event.preventDefault();
    const element = document.getElementById(slug);
    if (!element) {
      return;
    }

    element.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveHash(`#${slug}`);
    window.history.replaceState(null, "", `#${slug}`);
  };

  return (
    <ScrollArea className="docsfn-toc">
      <ScrollAreaViewport className="docsfn-toc-viewport">
        <nav className="docsfn-toc-nav" aria-label="Table of contents">
          <div className="docsfn-toc-title">On this page</div>
          <ul className="docsfn-toc-list">
            {resolvedHeadings.map((heading) => {
              const isActive = activeHash === `#${heading.slug}`;
              return (
                <li
                  key={heading.slug}
                  className="docsfn-toc-item"
                  data-level={heading.level}
                  style={{ paddingLeft: (heading.level - 1) * 12 }}
                >
                  <a
                    href={`#${heading.slug}`}
                    onClick={(event) => handleClick(event, heading.slug)}
                    className={`docsfn-toc-link ${isActive ? "active" : ""}`}
                    data-active={isActive}
                    aria-current={isActive ? "location" : undefined}
                  >
                    {heading.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </ScrollAreaViewport>
    </ScrollArea>
  );
}
