import { expect, it } from "vitest";
import { getPaginationFromSidebarWithTitles, selectApiReferenceRoute } from "./helpers";
import { buildOpenApiReference } from "./openapi";
import type { ApiReference, DocPage, Sidebar } from "./types";

it("keeps the other pagination direction when only one direction is overridden", () => {
  const pages = Object.fromEntries(["a", "b", "c"].map((slug) => [slug, {
    kind: "page", id: slug, slug, path: `/${slug}`, title: slug.toUpperCase(),
    body: "", headings: [], frontmatter: slug === "b" ? { prev: "/custom" } : {},
  } satisfies DocPage]));
  const sidebar: Sidebar = { id: "docs", items: ["a", "b", "c"].map((slug) => ({ type: "link", text: slug, link: `/${slug}` })) };
  expect(getPaginationFromSidebarWithTitles("/b", sidebar, pages)).toMatchObject({
    prev: { path: "/custom" }, next: { path: "/c", title: "C" },
  });
});

it("projects API subroutes without mutating the manifest overview", () => {
  const spec = buildOpenApiReference({ sourceId: "api:x.json", sourcePath: "x.json", fallbackTitle: "X", body: JSON.stringify({
    openapi: "3.0.3", info: { title: "X", version: "1" },
    paths: { "/a": { get: { tags: ["A"], responses: {} } }, "/b": { get: { tags: ["B"], responses: {} } } },
  }) });
  const api: ApiReference = { kind: "api", id: "x", slug: "x", path: spec.routes.overview, title: spec.title, frontmatter: {}, spec };
  const operation = spec.operations[0];
  const selected = selectApiReferenceRoute(api, operation.routePath);
  expect(selected.path).toBe(operation.routePath);
  expect((selected.spec as typeof spec).operations).toEqual([operation]);
  expect(spec.operations).toHaveLength(2);
  expect(selectApiReferenceRoute(api, api.path)).toBe(api);
});
