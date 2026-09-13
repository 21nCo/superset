import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { BlogPost } from "@docsfn/core/browser";
import ChangelogEntry from "./ChangelogEntry.svelte";
import ChangelogList from "./ChangelogList.svelte";

const changelogPost: BlogPost = {
  kind: "post",
  id: "collection:changelog:docsfn-v0-1-0.md",
  collectionId: "changelog",
  collectionLabel: "Changelog",
  searchScope: "changelog",
  slug: "docsfn-v0-1-0",
  path: "/changelog/docsfn-v0-1-0",
  title: "Docsfn v0.1.0 Changelog Foundation",
  date: "2026-07-10",
  publishedAt: "2026-07-10T00:00:00.000Z",
  excerpt: "Reusable changelog UI components.",
  tags: ["changelog", "docsfn"],
  body: "Body",
  frontmatter: {},
};

afterEach(() => {
  cleanup();
});

describe("dated collection Svelte components", () => {
  it("renders a changelog list from shared post data", () => {
    render(ChangelogList, {
      posts: [changelogPost],
      title: "Changelog",
    });

    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy();
    const link = screen.getByRole("link", {
      name: /Docsfn v0\.1\.0 Changelog Foundation/,
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/changelog/docsfn-v0-1-0");
    expect(screen.getByText("Reusable changelog UI components.")).toBeTruthy();
  });

  it("uses compact list chrome in embedded mode", () => {
    render(ChangelogList, {
      posts: [changelogPost],
      description: "Product updates and release notes.",
      embedded: true,
    });

    expect(screen.queryByText("Product updates and release notes.")).toBeNull();
    expect(document.querySelector(".docsfn-dated-list--embedded")).toBeTruthy();
  });

  it("renders changelog entry metadata and back navigation", () => {
    render(ChangelogEntry, {
      post: changelogPost,
      collectionHref: "/changelog",
    });

    expect(screen.getByRole("link", { name: "Changelog" }).getAttribute("href")).toBe(
      "/changelog"
    );
    expect(screen.getByRole("heading", { name: "Docsfn v0.1.0 Changelog Foundation" }))
      .toBeTruthy();
    expect(screen.getByText("changelog")).toBeTruthy();
    expect(screen.getByText("docsfn")).toBeTruthy();
  });
});
