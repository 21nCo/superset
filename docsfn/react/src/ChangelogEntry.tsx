import React, { type ReactNode } from "react";
import type { BlogPost } from "@docsfn/core";
import { DatedCollectionEntry } from "./DatedCollectionEntry";

export interface ChangelogEntryProps {
  post: BlogPost;
  children: ReactNode;
  collectionLabel?: string;
  collectionHref?: string;
  embedded?: boolean;
  showBackLink?: boolean;
}

export function ChangelogEntry({
  post,
  children,
  collectionLabel = "Changelog",
  collectionHref = "/changelog",
  embedded = false,
  showBackLink = true,
}: ChangelogEntryProps) {
  return (
    <DatedCollectionEntry
      post={post}
      collectionLabel={collectionLabel}
      collectionHref={collectionHref}
      embedded={embedded}
      showBackLink={showBackLink}
    >
      {children}
    </DatedCollectionEntry>
  );
}
