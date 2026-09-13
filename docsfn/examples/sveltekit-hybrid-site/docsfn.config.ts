import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "Northstar Cloud",
    description:
      "Hybrid docsfn example with landing pages, docs, papers, blog, standalone markdown pages, and OpenAPI references.",
    basePath: "/docs",
    canonicalUrl: "https://northstar.example.com"
  },
  compat: {
    preset: "none"
  },
  content: {
    root: ".",
    docsDir: "content/docs",
    blogDir: "content/blog",
    pagesDir: "content/pages",
    apiDir: "content/api"
  },
  navigation: {
    topNav: [
      { label: "Home", href: "/" },
      { label: "Docs", href: "/docs" },
      { label: "Papers", href: "/papers" },
      { label: "API", href: "/docs/api/commerce" },
      { label: "Blog", href: "/blog" },
      { label: "Help", href: "/help/faq" }
    ]
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog"],
    bodyIndexing: "summary"
  },
  auth: {
    enabled: false,
    mode: "public"
  },
  analytics: {
    enabled: false,
    provider: "watchfn",
    respectDnt: true
  }
};

export const papersConfig: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "Northstar Cloud Papers",
    description: "Long-form papers rendered through a dedicated docsfn manifest.",
    basePath: "/papers",
    canonicalUrl: "https://northstar.example.com"
  },
  compat: {
    preset: "none"
  },
  content: {
    root: ".",
    docsDir: "content/papers"
  },
  navigation: {
    sidebars: {
      edge: { title: "Edge Computing", root: true, include: ["docs/edge-computing/**"] },
      vector: { title: "Vector Retrieval", root: true, include: ["docs/vector-playbook/**"] }
    }
  },
  search: {
    enabled: true,
    scopes: ["docs"],
    bodyIndexing: "summary"
  },
  auth: {
    enabled: false,
    mode: "public"
  },
  analytics: {
    enabled: false,
    provider: "watchfn",
    respectDnt: true
  }
};

export default config;
