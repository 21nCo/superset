import React from "react";
import type { BlogPost } from "@docsfn/core";

export interface DatedCollectionListProps {
  posts: BlogPost[];
  title?: string;
  description?: string;
  embedded?: boolean;
  emptyLabel?: string;
  ariaLabel?: string;
  getPostHref?: (post: BlogPost) => string;
}

export function DatedCollectionList({
  posts,
  title = "Updates",
  description,
  embedded = false,
  emptyLabel = "No entries yet.",
  ariaLabel,
  getPostHref,
}: DatedCollectionListProps) {
  return (
    <section
      className={`docsfn-dated-list docsfn-layout ${embedded ? "docsfn-dated-list--embedded" : ""}`}
      aria-label={ariaLabel ?? title}
    >
      <header className="docsfn-dated-list-header">
        <h1>{title}</h1>
        {description && !embedded ? <p>{description}</p> : null}
      </header>
      {posts.length === 0 ? (
        <p className="docsfn-dated-list-empty">{emptyLabel}</p>
      ) : (
        <ol className="docsfn-dated-list-items">
          {posts.map((post) => (
            <li key={post.id}>
              <a className="docsfn-dated-list-card" href={getPostHref?.(post) ?? post.path}>
                <span className="docsfn-dated-list-date"><time dateTime={post.date}>{post.date}</time></span>
                <span className="docsfn-dated-list-title">{post.title}</span>
                {post.excerpt ?? post.summary ? (
                  <p className="docsfn-dated-list-excerpt">{post.excerpt ?? post.summary}</p>
                ) : null}
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
