import React from "react";
import { render, screen } from "@testing-library/react";
import type { BlogPost } from "@docsfn/core";
import { describe, expect, it } from "vitest";
import { ChangelogEntry } from "./ChangelogEntry";
import { ChangelogList } from "./ChangelogList";

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

describe("dated collection React components", () => {
  it("renders a changelog list from shared post data", () => {
    render(<ChangelogList posts={[changelogPost]} />);

    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Docsfn v0\.1\.0 Changelog Foundation/ })
        .getAttribute("href")
    ).toBe("/changelog/docsfn-v0-1-0");
    expect(screen.getByText("Reusable changelog UI components.")).toBeTruthy();
  });

  it("renders compact embedded list chrome", () => {
    render(<ChangelogList posts={[changelogPost]} embedded />);

    expect(screen.queryByText("Product updates and release notes.")).toBeNull();
    expect(document.querySelector(".docsfn-dated-list--embedded")).toBeTruthy();
  });

  it("renders changelog entry metadata and back navigation", () => {
    render(
      <ChangelogEntry post={changelogPost}>
        <p>Release details</p>
      </ChangelogEntry>
    );

    expect(screen.getByRole("link", { name: "Changelog" }).getAttribute("href")).toBe(
      "/changelog"
    );
    expect(screen.getByRole("heading", { name: changelogPost.title })).toBeTruthy();
    expect(screen.getByText("Release details")).toBeTruthy();
    expect(screen.getByText("docsfn")).toBeTruthy();
  });
});
