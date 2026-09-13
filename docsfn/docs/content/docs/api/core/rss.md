---
title: core — RSS
description: generateRSSFeed in @docsfn/core.
---

# RSS (`@docsfn/core`)

## `generateRSSFeed(manifest, options)`

**`RSSFeedOptions`:**

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Channel title. |
| `description` | `string` | Channel description. |
| `link` | `string` | Public site/blog base URL (no trailing slash required; normalized). |
| `language?` | `string` | Default **`en`**. |
| `feedHref?` | `string` | Overrides the **`atom:link rel="self"`** URL (use when the served feed path differs from **`manifest.blog.feedPath`** under **`link`**). |
| `itemHref?` | `(post) => string` | Overrides per-item **`link`** / **`guid`** when public post URLs differ from **`link` + `post.path`**. |

**Returns:** `string` — RSS 2.0 XML with Atom **`atom:link rel="self"`** (default: **`link`** + **`manifest.blog.feedPath`** unless **`feedHref`** is set).

Ordering prefers **`manifest.blog.postOrder`**; otherwise sorts posts by publish timestamp.

**Note:** The public function name is **`generateRSSFeed`** (not `buildRssFeed`).
