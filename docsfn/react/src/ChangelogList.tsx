import React from "react";
import type { BlogPost } from "@docsfn/core";
import { DatedCollectionList } from "./DatedCollectionList";

export interface ChangelogListProps {
  posts: BlogPost[];
  title?: string;
  description?: string;
  embedded?: boolean;
  emptyLabel?: string;
  getPostHref?: (post: BlogPost) => string;
}

export function ChangelogList({
  posts,
  title = "Changelog",
  description = "Product updates and release notes.",
  embedded = false,
  emptyLabel = "No changelog entries yet.",
  getPostHref,
}: ChangelogListProps) {
  return (
    <DatedCollectionList
      posts={posts}
      title={title}
      description={description}
      embedded={embedded}
      emptyLabel={emptyLabel}
      ariaLabel={title}
      getPostHref={getPostHref}
    />
  );
}
