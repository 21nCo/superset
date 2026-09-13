---
title: Versioning
description: docsfn version modes, URLs, frontmatter, static params, and the VersionSwitcher component.
---

# Versioning

Versioned docs shift URL segments based on **`versions.mode`** in `docsfn.config.ts`. Versions are declared in **`versions.versions`** with **`slug`**, **`label`**, and optional **`default`**.

See also: [Configuration](./configuration), [Navigation](./navigation).

## Modes

| Mode | Behavior |
| --- | --- |
| **`none`** | Default. No version segment in paths. |
| **`path-prefix`** | Version slug is the **first** segment after `basePath` (e.g. `/docs/v2/getting-started`). |
| **`path-segment`** | Version slug is the **last** segment (e.g. `/docs/getting-started/v2`). |

## Config example

```ts
versions: {
  mode: "path-prefix",
  versions: [
    { slug: "v1", label: "1.x", default: true },
    { slug: "v2", label: "2.x" },
  ],
},
```

In **`docsfn.config.ts`** each version entry uses optional **`default: true`** for the default slug; the built manifest maps that to **`Version.isDefault`** for UI helpers.

## URL generation

For **docs** pages, **`buildRoute`** resolves **`resolveVersionContext`** from logical path + frontmatter, then applies the version to the slug internally:

- **path-prefix:** `[version, ...restOfSlug]`
- **path-segment:** `[...restOfSlug, version]`

**Pages** and **blog** collections do not apply the same version slug rules as docs in core routing today—versioning is focused on the **docs** tree.

## Version detection

- From **frontmatter** when a version field is present (see `resolveVersionContext` in core).
- From **path segments** that match configured version slugs when inferring static params.

## `VersionSwitcher` (`@docsfn/svelte`)

Props:

- **`surface`** — Optional; supplies `versions`, `currentVersion`, and **`versionLinks`** (per-slug hrefs from the adapter).
- **`versions`** / **`currentVersion`** — Overrides when not using `surface`.
- **`onVersionChange`** — Custom handler; if omitted, the component uses **`surface.versionLinks`** or rewrites the first path-prefix segment client-side.

The switcher renders only when **more than one** version exists and a current slug is known. It uses a dropdown (uifn) to pick a version.

## Static params

**`buildDocsStaticParams`** maps manifest routes to params:

- Under **path-prefix**, if the first segment is a version slug, it returns `{ version, slug: [...] }`.
- Under **path-segment**, if the last segment is a version slug, it splits accordingly.
- Otherwise `{ slug: [...] }` only.

Use the same logic in SvelteKit **`entries`** or Next **`generateStaticParams`** as your kit package exports.
