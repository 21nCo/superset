---
title: Introducing docsfn
date: "2026-03-22"
author: 21n
tags: [release, announcement]
description: Meet docsfn — the documentation toolchain for superfunctions.
---

docsfn is a **self-hosted documentation toolchain** for the superfunctions ecosystem and any project that wants the same building blocks: a single content tree, a typed manifest, full-text search, optional blog and OpenAPI-backed API reference pages, and first-class adapters for **SvelteKit** and **Next.js**.

We built it because we wanted one pipeline that stays honest about where content lives, how routes are generated, and how search and RSS stay in sync with the manifest—without locking you into a single framework or a hosted SaaS.

## What you get

- **Multi-framework routing** — Wire **SvelteKit** or **Next.js** to the same `DocsManifest`: catch-all doc routes, blog listing and posts, search JSON, and RSS where you enable them.
- **Native Markdown (and MDX where configured)** — Write docs and posts as files under configurable directories; frontmatter and `meta.json` trees drive navigation and sidebars.
- **Full-text search** — Build a search artifact from your content; the runtime scopes queries across docs, API reference, and blog when you opt in.
- **Blog** — Dated posts, listings, tags, and **RSS 2.0** via `generateRSSFeed` from `@docsfn/core`.
- **OpenAPI** — Promote OpenAPI specs into browsable API reference pages that participate in search and routing like the rest of the site.
- **CLI** — `docsfn validate` and `docsfn build` for manifests, diagnostics, and artifacts you can check in CI.

## How this differs

Many doc products optimize for a single meta-framework or a hosted editor. docsfn optimizes for **repos you own**: plain files, explicit config (`docsfn.config.ts`), and adapters that only bridge manifests to your framework’s loaders and server routes. You keep deployment, auth, and caching choices on your side.

## Getting started

Create a `docsfn.config.ts`, point `content.docsDir` and `content.blogDir` at your trees, run **`docsfn validate`** and **`docsfn build`**, then follow the [SvelteKit integration guide](/docs/guides/sveltekit) or [Next.js guide](/docs/guides/nextjs) to mount routes. The [quick start](/docs/getting-started/quick-start) page walks through the minimal file layout.

## What’s next

We will keep tightening diagnostics, expanding guides, and aligning adapters as superfunctions packages evolve. If you adopt docsfn in your own repo, issues and feedback help set the roadmap.

Thanks for reading—welcome to docsfn.
