---
title: core — Analytics
description: Canonical analytics event names and emit helpers in @docsfn/core.
---

# Analytics (`@docsfn/core`)

## Event names

**`CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`:**

- `docs.pageview`
- `docs.search`
- `docs.search_result_click`
- `docs.external_click`

**`DocsAnalyticsEventName`** — union of the above.

## `DocsAnalyticsEvent`

Fields include **`name`**, ISO **`timestamp`**, **`route`**, optional **`version`**, **`sidebarId`**, **`searchScope`**, **`resultCount`**, **`targetUrl`**.

## Emit pipeline

| Function | Role |
| --- | --- |
| **`maybeEmitAnalyticsEvent`** | Respects **`respectDnt`** + optional explicit DNT value; calls your **`emit`** callback. |
| **`createDocsAnalyticsEmitter`** | Factory for a reusable emitter with defaults. |
| **`isCanonicalDocsAnalyticsEventName(value)`** | Type guard — returns `true` when `value` is one of the canonical event names. |
| **`sanitizeDocsAnalyticsEvent(event)`** | Redacts sensitive URL query params from event fields. Returns sanitized event or `null` if the event is invalid. |

URL-like fields are sanitized to drop sensitive query keys before emission (see implementation in `analytics.ts`).

## Input types

**`DocsAnalyticsEmitInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Master switch. |
| `respectDnt` | `boolean` | When `true`, suppresses emit if Do Not Track is active. |
| `event` | `DocsAnalyticsEvent` | The event payload. |
| `emit` | `(event: DocsAnalyticsEvent) => void` | Your emit callback. |
| `doNotTrackValue?` | `string \| null` | Explicit DNT header value override. |

**`CreateDocsAnalyticsEmitterInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `enabled?` | `boolean` | Default `false`. |
| `respectDnt?` | `boolean` | Default `true`. |
| `emit` | `(event: DocsAnalyticsEvent) => void` | Your emit callback. |
| `doNotTrackValue?` | `string \| null` | Explicit DNT header value override. |
