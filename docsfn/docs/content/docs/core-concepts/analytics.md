---
title: Analytics
description: Canonical docsfn analytics events, DNT, watchfn provider, and URL sanitization.
---

# Analytics

docsfn defines a small **canonical event vocabulary** and helpers to emit events only when analytics is enabled and **Do Not Track** is respected.

See also: [Configuration](./configuration), [Search](./search), [Security](./security).

## Event types

**`CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`** in core:

| Name | Typical use |
| --- | --- |
| `docs.pageview` | Route viewed. |
| `docs.search` | Search query executed. |
| `docs.search_result_click` | User opened a result. |
| `docs.external_click` | Outbound link from docs UI. |

## Event shape

**`DocsAnalyticsEvent`** fields:

- **`name`** — One of the canonical names above.
- **`timestamp`** — ISO string.
- **`route`** — Current docs route (sanitized).
- **`version`**, **`sidebarId`**, **`searchScope`**, **`resultCount`**, **`targetUrl`** — Optional context.

## Config

```ts
analytics: {
  enabled: true,
  provider: "watchfn",
  respectDnt: true,
},
```

Only **`watchfn`** is defined as the provider enum today; your **`emit`** callback receives structured events for forwarding to WatchFn or another backend.

## DNT respect

**`maybeEmitAnalyticsEvent`** checks **`respectDnt`**. When true, it resolves **`navigator.doNotTrack`** / **`window.doNotTrack`** (string `"1"` / `"yes"` semantics) and **skips** emission if the user has DNT enabled.

You may pass **`doNotTrackValue`** explicitly in tests or SSR stubs.

## URL sanitization

Before emit, path-like fields run through **`sanitizePathLikeValue`**:

- Parses URLs (absolute or relative against a dummy origin).
- **Drops** query parameters whose names match sensitive patterns (`token`, `secret`, `key`, `authorization`, `cookie`, `session`, `password`, `sig`, …).
- Runs values through **`redactSensitivePayload`** so hazardous values are removed rather than logged.

This reduces accidental leakage of signed URLs or API keys in analytics payloads.

## Components

**`DocsSearch`** accepts an **`analytics`** prop and calls **`maybeEmitAnalyticsEvent`** for search-related actions when configured.
