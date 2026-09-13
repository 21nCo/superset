import React from "react";
import type { BlogPost } from "@docsfn/core";

export interface BlogListProps {
  posts: BlogPost[];
  selectedTag?: string;
  onTagClick?: (tag: string) => void;
}

function comparePosts(left: BlogPost, right: BlogPost): number {
  const leftDate = Date.parse(left.publishedAt ?? left.date);
  const rightDate = Date.parse(right.publishedAt ?? right.date);
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
    return rightDate - leftDate;
  }
  return left.slug.localeCompare(right.slug, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

export function BlogList({ posts, selectedTag, onTagClick }: BlogListProps) {
  const normalizedTag =
    typeof selectedTag === "string" && selectedTag.length > 0
      ? selectedTag.toLowerCase()
      : undefined;

  const sortedPosts = [...posts].sort((left, right) =>
    comparePosts(left, right)
  );

  const filteredPosts = normalizedTag
    ? sortedPosts.filter((post) => post.tags.some((tag) => tag === normalizedTag))
    : sortedPosts;

  const allTags = Array.from(
    new Set(posts.flatMap((post) => post.tags))
  ).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );

  return (
    <div className="docsfn-blog-list">
      {allTags.length > 0 && (
        <div className="docsfn-blog-tags">
          <button
            onClick={() => onTagClick?.("")}
            className={`docsfn-blog-tag ${!normalizedTag ? "active" : ""}`}
            data-active={!normalizedTag}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagClick?.(tag)}
              className={`docsfn-blog-tag ${normalizedTag === tag ? "active" : ""}`}
              data-active={normalizedTag === tag}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className="docsfn-blog-posts">
        {filteredPosts.length === 0 ? (
          <p className="docsfn-blog-empty">No posts found.</p>
        ) : (
          filteredPosts.map((post) => (
            <article key={post.id} className="docsfn-blog-post">
              <a href={post.path} className="docsfn-blog-post-link">
                <time className="docsfn-blog-post-date">
                  {new Date(post.publishedAt ?? post.date).toLocaleDateString("en-US", {
                    timeZone: "UTC",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
                <h2 className="docsfn-blog-post-title">{post.title}</h2>
                {post.excerpt || post.summary ? (
                  <p className="docsfn-blog-post-excerpt">{post.excerpt ?? post.summary}</p>
                ) : null}
                {post.author ? <p className="docsfn-blog-post-author">By {post.author}</p> : null}
                {post.tags.length > 0 && (
                  <div className="docsfn-blog-post-tags">
                    {post.tags.map((tag) => (
                      <span key={tag} className="docsfn-blog-post-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </a>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
