import React, { type ReactNode } from "react";
import type { BlogPost } from "@docsfn/core";
import { ArrowLeft } from "lucide-react";

export interface DatedCollectionEntryProps {
  post: BlogPost;
  children: ReactNode;
  collectionLabel?: string;
  collectionHref?: string;
  embedded?: boolean;
  showBackLink?: boolean;
}

export function DatedCollectionEntry({
  post,
  children,
  collectionLabel = post.collectionLabel ?? "Updates",
  collectionHref,
  embedded = false,
  showBackLink = true,
}: DatedCollectionEntryProps) {
  return (
    <article className={`docsfn-dated-entry docsfn-layout ${embedded ? "docsfn-dated-entry--embedded" : ""}`}>
      {!embedded && showBackLink && collectionHref ? (
        <a className="docsfn-dated-entry-back" href={collectionHref}>
          <ArrowLeft size={15} strokeWidth={1.8} aria-hidden="true" /> {collectionLabel}
        </a>
      ) : null}
      <header className="docsfn-dated-entry-header">
        <p className="docsfn-dated-entry-date"><time dateTime={post.date}>{post.date}</time></p>
        <h1>{post.title}</h1>
        {post.tags?.length ? (
          <ul className="docsfn-dated-entry-tags">
            {post.tags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        ) : null}
      </header>
      <div className="docsfn-dated-entry-body">{children}</div>
    </article>
  );
}
