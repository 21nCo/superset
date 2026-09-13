import { describe, expect, it } from "vitest";
import {
  CANONICAL_DOCS_ANALYTICS_EVENT_NAMES,
  createDocsAnalyticsEmitter,
  maybeEmitAnalyticsEvent,
  sanitizeDocsAnalyticsEvent,
} from "./analytics";

describe("analytics", () => {
  it("suppresses analytics emission when DNT is enabled (TV-OBS-001)", () => {
    const events: Array<{ name: string }> = [];
    const emitted = maybeEmitAnalyticsEvent({
      enabled: true,
      respectDnt: true,
      doNotTrackValue: "1",
      event: {
        name: "docs.pageview",
        timestamp: "2026-03-20T00:00:00Z",
        route: "/docs",
      },
      emit: (event) => events.push({ name: event.name }),
    });

    expect(emitted).toBe(false);
    expect(events).toEqual([]);
  });

  it("is opt-in and disabled by default", () => {
    const events: Array<{ name: string }> = [];
    const emitAnalytics = createDocsAnalyticsEmitter({
      emit: (event) => events.push({ name: event.name }),
    });

    const emitted = emitAnalytics({
      name: "docs.search",
      timestamp: "2026-03-20T00:00:00Z",
      route: "/docs",
      resultCount: 2,
      searchScope: "docs",
    });

    expect(emitted).toBe(false);
    expect(events).toEqual([]);
  });

  it("emits canonical events when enabled", () => {
    const events: Array<{ name: string; route: string }> = [];

    const emitted = maybeEmitAnalyticsEvent({
      enabled: true,
      respectDnt: true,
      doNotTrackValue: "0",
      event: {
        name: "docs.search_result_click",
        timestamp: "2026-03-20T00:00:00Z",
        route: "/docs/reference",
        targetUrl: "/docs/reference/client",
      },
      emit: (event) => events.push({ name: event.name, route: event.route }),
    });

    expect(emitted).toBe(true);
    expect(events).toEqual([
      {
        name: "docs.search_result_click",
        route: "/docs/reference",
      },
    ]);
  });

  it("drops invalid event names", () => {
    const events: unknown[] = [];

    const emitted = maybeEmitAnalyticsEvent({
      enabled: true,
      respectDnt: false,
      doNotTrackValue: "0",
      event: {
        name: "docs.unknown_event",
        timestamp: "2026-03-20T00:00:00Z",
        route: "/docs",
      } as never,
      emit: (event) => events.push(event),
    });

    expect(emitted).toBe(false);
    expect(events).toEqual([]);
  });

  it("sanitizes payload URLs and strips sensitive query values", () => {
    const sanitized = sanitizeDocsAnalyticsEvent({
      name: "docs.external_click",
      timestamp: "2026-03-20T00:00:00Z",
      route: "/docs?token=abc123&tab=api",
      targetUrl: "https://example.com/path?api_key=abc&ref=docs",
    });

    expect(sanitized).toMatchObject({
      name: "docs.external_click",
      route: "/docs?tab=api",
      targetUrl: "https://example.com/path?ref=docs",
    });
  });

  it("preserves version and sidebar identifiers instead of path-normalizing them", () => {
    const sanitized = sanitizeDocsAnalyticsEvent({
      name: "docs.pageview",
      timestamp: "2026-03-20T00:00:00Z",
      route: "/docs/guide",
      version: "v1",
      sidebarId: "default",
    });

    expect(sanitized).toMatchObject({
      name: "docs.pageview",
      route: "/docs/guide",
      version: "v1",
      sidebarId: "default",
    });
  });

  it("exposes the canonical event names from SPEC.md", () => {
    expect(CANONICAL_DOCS_ANALYTICS_EVENT_NAMES).toEqual([
      "docs.pageview",
      "docs.search",
      "docs.search_result_click",
      "docs.external_click",
    ]);
  });
});

it('drops complete URL fragments without changing stable identifiers', () => {
  expect(sanitizeDocsAnalyticsEvent({ name: 'docs.external_click', timestamp: '2026-03-20T00:00:00Z', route: '/docs#access_token=opaque', targetUrl: 'https://example.com/#opaque', version: 'v1', sidebarId: 'default' })).toMatchObject({ route: '/docs', targetUrl: 'https://example.com/', version: 'v1', sidebarId: 'default' });
});
