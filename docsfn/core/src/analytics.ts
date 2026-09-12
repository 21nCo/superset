import { redactSensitivePayload } from "./security";
import type { DocsSearchScope } from "./search";

export const CANONICAL_DOCS_ANALYTICS_EVENT_NAMES = [
  "docs.pageview",
  "docs.search",
  "docs.search_result_click",
  "docs.external_click",
] as const;

export type DocsAnalyticsEventName =
  (typeof CANONICAL_DOCS_ANALYTICS_EVENT_NAMES)[number];

export interface DocsAnalyticsEvent {
  name: DocsAnalyticsEventName;
  timestamp: string;
  route: string;
  version?: string;
  sidebarId?: string;
  searchScope?: DocsSearchScope;
  resultCount?: number;
  targetUrl?: string;
}

export interface DocsAnalyticsEmitInput {
  enabled: boolean;
  respectDnt: boolean;
  event: DocsAnalyticsEvent;
  emit: (event: DocsAnalyticsEvent) => void;
  doNotTrackValue?: string | null;
}

export interface CreateDocsAnalyticsEmitterInput {
  enabled?: boolean;
  respectDnt?: boolean;
  emit: (event: DocsAnalyticsEvent) => void;
  doNotTrackValue?: string | null;
}

const SENSITIVE_QUERY_KEY_PATTERN =
  /(token|secret|key|authorization|cookie|session|password|sig)/i;

function isDocsSearchScope(value: unknown): value is DocsSearchScope {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveDoNotTrackValue(input?: string | null): string | null {
  if (typeof input === "string") {
    return input;
  }

  const globalValue = globalThis as Record<string, unknown>;
  const navigatorValue =
    typeof globalValue.navigator === "object" && globalValue.navigator !== null
      ? (globalValue.navigator as Record<string, unknown>).doNotTrack
      : undefined;
  if (typeof navigatorValue === "string") {
    return navigatorValue;
  }

  const windowValue =
    typeof globalValue.window === "object" && globalValue.window !== null
      ? (globalValue.window as Record<string, unknown>).doNotTrack
      : undefined;
  if (typeof windowValue === "string") {
    return windowValue;
  }

  return null;
}

function sanitizeIdentifierValue(value: string): string {
  const redacted = redactSensitivePayload(value);
  return typeof redacted === "string" && redacted !== "[REDACTED]" ? redacted : "";
}

function sanitizePathLikeValue(value: string): string {
  if (!value) {
    return value;
  }

  try {
    const parsed = new URL(value, "https://docsfn.local");
    const nextParams = new URLSearchParams();

    for (const [key, paramValue] of parsed.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        continue;
      }
      const redacted = redactSensitivePayload(paramValue);
      if (typeof redacted !== "string" || redacted === "[REDACTED]") {
        continue;
      }
      nextParams.append(key, redacted);
    }

    parsed.search = nextParams.toString();
    parsed.hash = "";
    const normalizedPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    if (value.startsWith("http://") || value.startsWith("https://")) {
      return `${parsed.origin}${normalizedPath}`;
    }

    return normalizedPath;
  } catch {
    const redacted = redactSensitivePayload(value);
    return typeof redacted === "string" ? redacted : "";
  }
}

export function isCanonicalDocsAnalyticsEventName(
  value: string
): value is DocsAnalyticsEventName {
  return (CANONICAL_DOCS_ANALYTICS_EVENT_NAMES as readonly string[]).includes(value);
}

export function sanitizeDocsAnalyticsEvent(
  event: DocsAnalyticsEvent
): DocsAnalyticsEvent | null {
  if (!isCanonicalDocsAnalyticsEventName(event.name)) {
    return null;
  }

  const route = sanitizePathLikeValue(event.route).trim();
  if (!route) {
    return null;
  }

  const timestamp =
    typeof event.timestamp === "string" && event.timestamp.trim().length > 0
      ? event.timestamp
      : new Date().toISOString();

  const sanitized: DocsAnalyticsEvent = {
    name: event.name,
    timestamp,
    route,
  };

  if (typeof event.version === "string" && event.version.trim().length > 0) {
    const version = sanitizeIdentifierValue(event.version.trim());
    if (version) {
      sanitized.version = version;
    }
  }

  if (typeof event.sidebarId === "string" && event.sidebarId.trim().length > 0) {
    const sidebarId = sanitizeIdentifierValue(event.sidebarId.trim());
    if (sidebarId) {
      sanitized.sidebarId = sidebarId;
    }
  }

  if (isDocsSearchScope(event.searchScope)) {
    sanitized.searchScope = event.searchScope;
  }

  if (
    typeof event.resultCount === "number" &&
    Number.isFinite(event.resultCount) &&
    event.resultCount >= 0
  ) {
    sanitized.resultCount = Math.floor(event.resultCount);
  }

  if (typeof event.targetUrl === "string" && event.targetUrl.trim().length > 0) {
    sanitized.targetUrl = sanitizePathLikeValue(event.targetUrl.trim());
  }

  return sanitized;
}

export function maybeEmitAnalyticsEvent(input: DocsAnalyticsEmitInput): boolean {
  if (!input.enabled) {
    return false;
  }

  const doNotTrackValue = resolveDoNotTrackValue(input.doNotTrackValue);
  if (input.respectDnt && doNotTrackValue === "1") {
    return false;
  }

  const sanitizedEvent = sanitizeDocsAnalyticsEvent(input.event);
  if (!sanitizedEvent) {
    return false;
  }

  input.emit(sanitizedEvent);
  return true;
}

export function createDocsAnalyticsEmitter(input: CreateDocsAnalyticsEmitterInput) {
  const enabled = input.enabled ?? false;
  const respectDnt = input.respectDnt ?? true;

  return (event: DocsAnalyticsEvent) =>
    maybeEmitAnalyticsEvent({
      enabled,
      respectDnt,
      emit: input.emit,
      doNotTrackValue: input.doNotTrackValue,
      event,
    });
}
