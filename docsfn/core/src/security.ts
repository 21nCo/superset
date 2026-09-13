import { createDiagnostic, createDocsError } from "./diagnostics";
import { findUnsafeHtml } from "./sanitize";
import type { DocsConfig, DocsDiagnostic } from "./types";
import type { DocsSourceEntry } from "./provider";

export const CANONICAL_DOCS_AUTH_MODES = ["public", "private", "mixed"] as const;

export type DocsAuthMode = (typeof CANONICAL_DOCS_AUTH_MODES)[number];

const SENSITIVE_KEY_PATTERN =
  /(secret|token|cookie|authorization|password|passwd|api[-_]?key|private[-_]?key|raw[-_]?body|raw[-_]?content|session)/i;

const SENSITIVE_VALUE_PATTERN =
  /(bearer\s+[a-z0-9._-]+|xox[baprs]-[a-z0-9-]+|gh[pousr]_[a-z0-9]+|sk_[a-z0-9]+|api[_-]?key\s*[:=])/i;

const RAW_HTML_ALLOWLIST_ENV = "DOCSFN_HTML_UNSAFE_ALLOWLIST";

export interface ResolveUnsafeHtmlAllowlistInput {
  value?: string;
}

export interface SourceTrustPolicy {
  allowUnsafeHtml?: boolean;
  allowUnsafeHtmlAllowlist?: string[];
}

export interface AssertSourceEntriesTrustedInput {
  entries: DocsSourceEntry[];
  policy?: SourceTrustPolicy;
}

export interface AssertCompiledContentTrustedInput {
  source: string;
  sourcePath?: string;
  policy?: SourceTrustPolicy;
}

export interface AssertDocsRouteAccessInput {
  config: Pick<DocsConfig, "auth">;
  route: string;
  session?: unknown | null;
  resolveSession?: () => unknown | Promise<unknown>;
  isRoutePrivate?: (route: string) => boolean;
  authorize?: (input: { route: string; session: unknown }) => boolean | Promise<boolean>;
}

export interface DocsRouteAccessResult {
  mode: DocsAuthMode;
  route: string;
  requiresAuth: boolean;
  allowed: boolean;
}

function normalizeMatchCandidate(value: string): string {
  return value.replaceAll("\\", "/").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toGlobRegex(glob: string): RegExp {
  const escaped = escapeRegex(normalizeMatchCandidate(glob)).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAllowlist(entry: DocsSourceEntry, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return false;
  }

  const candidates = [entry.id, entry.relativePath, entry.absolutePath]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeMatchCandidate);

  for (const rule of allowlist) {
    const trimmedRule = normalizeMatchCandidate(rule);
    if (!trimmedRule) {
      continue;
    }
    const regex = toGlobRegex(trimmedRule);
    if (candidates.some((candidate) => regex.test(candidate))) {
      return true;
    }
  }

  return false;
}

function isMarkdownContentEntry(entry: DocsSourceEntry): boolean {
  if (entry.entryType !== "content") {
    return false;
  }

  return (
    entry.collection === "docs" ||
    entry.collection === "pages" ||
    entry.collection === "blog" ||
    entry.collection.startsWith("collection:")
  );
}

function normalizeTrustPolicy(policy?: SourceTrustPolicy): SourceTrustPolicy {
  const allowlistFromEnv = resolveUnsafeHtmlAllowlist({});
  const allowUnsafeHtmlAllowlist = [
    ...(policy?.allowUnsafeHtmlAllowlist ?? []),
    ...allowlistFromEnv,
  ];

  return {
    allowUnsafeHtml: policy?.allowUnsafeHtml ?? false,
    allowUnsafeHtmlAllowlist,
  };
}

export function resolveUnsafeHtmlAllowlist(
  input: ResolveUnsafeHtmlAllowlistInput
): string[] {
  const envValue =
    typeof process !== "undefined" && process.env ? process.env[RAW_HTML_ALLOWLIST_ENV] : undefined;
  const raw = (input.value ?? envValue ?? "").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function resolveDocsAuthMode(config: Pick<DocsConfig, "auth">): DocsAuthMode {
  if (!config.auth?.enabled) {
    return "public";
  }

  return config.auth.mode;
}

export function isDocsContentProtected(input: {
  auth: DocsConfig["auth"] | undefined;
  frontmatter?: Record<string, unknown>;
  route: string;
}): boolean {
  if (!input.auth?.enabled) {
    return false;
  }

  const authMode = resolveDocsAuthMode({ auth: input.auth });
  if (authMode === "private") {
    return true;
  }
  if (authMode === "public") {
    return false;
  }

  const frontmatterPrivate =
    input.frontmatter?.private === true || input.frontmatter?.auth === "private";
  const routePrivate = /\/private(?:\/|$)/i.test(input.route);
  return frontmatterPrivate || routePrivate;
}

export function redactSensitiveText(value: string): string {
  if (!SENSITIVE_VALUE_PATTERN.test(value)) {
    return value;
  }

  return "[REDACTED]";
}

export function redactSensitivePayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item)) as T;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = redactSensitivePayload(nestedValue);
  }

  return output as T;
}

export function collectUnsafeHtmlDiagnostics(
  input: AssertSourceEntriesTrustedInput
): DocsDiagnostic[] {
  const policy = normalizeTrustPolicy(input.policy);
  const diagnostics: DocsDiagnostic[] = [];

  for (const entry of input.entries) {
    if (!isMarkdownContentEntry(entry)) {
      continue;
    }

    if (policy.allowUnsafeHtml) {
      continue;
    }

    if (matchesAllowlist(entry, policy.allowUnsafeHtmlAllowlist ?? [])) {
      continue;
    }

    const body = typeof entry.body === "string" ? entry.body : "";
    if (!body) {
      continue;
    }

    const matches = findUnsafeHtml(body);
    if (matches.length === 0) {
      continue;
    }

    diagnostics.push(
      createDiagnostic({
        code: "DOCS_HTML_UNSAFE",
        message: "unsafe HTML content is blocked by default",
        location: {
          sourceId: entry.id,
          absolutePath: entry.absolutePath,
        },
        details: {
          blockedCategories: matches.map((match) => match.category),
          matches,
        },
        suggestion:
          "Remove executable HTML or explicitly configure DOCSFN_HTML_UNSAFE_ALLOWLIST for approved paths.",
      })
    );
  }

  return diagnostics;
}

export function assertSourceEntriesTrusted(input: AssertSourceEntriesTrustedInput): void {
  const diagnostics = collectUnsafeHtmlDiagnostics(input);
  if (diagnostics.length === 0) {
    return;
  }

  throw createDocsError({
    code: "DOCS_HTML_UNSAFE",
    message: "unsafe HTML content is blocked by default",
    diagnostics,
  });
}

export function assertCompiledContentTrusted(
  input: AssertCompiledContentTrustedInput
): void {
  const policy = normalizeTrustPolicy(input.policy);
  if (policy.allowUnsafeHtml) {
    return;
  }

  const sourceId = input.sourcePath ?? "compiled-content";
  const allowlisted = matchesAllowlist(
    {
      id: sourceId,
      collection: "docs",
      relativePath: sourceId,
      absolutePath: input.sourcePath,
      entryType: "content",
      frontmatter: {},
      body: input.source,
    },
    policy.allowUnsafeHtmlAllowlist ?? []
  );

  if (allowlisted) {
    return;
  }

  const matches = findUnsafeHtml(input.source);
  if (matches.length === 0) {
    return;
  }

  throw createDocsError({
    code: "DOCS_HTML_UNSAFE",
    message: "unsafe HTML content is blocked by default",
    diagnostics: [
      createDiagnostic({
        code: "DOCS_HTML_UNSAFE",
        message: "unsafe HTML content is blocked by default",
        location: {
          absolutePath: input.sourcePath,
          sourceId,
        },
        details: {
          blockedCategories: matches.map((match) => match.category),
          matches,
        },
      }),
    ],
  });
}

function modeRequiresAuth(input: {
  mode: DocsAuthMode;
  route: string;
  isRoutePrivate?: (route: string) => boolean;
}): boolean {
  if (input.mode === "public") {
    return false;
  }

  if (input.mode === "private") {
    return true;
  }

  if (typeof input.isRoutePrivate === "function") {
    return input.isRoutePrivate(input.route);
  }

  return true;
}

export async function assertDocsRouteAccess(
  input: AssertDocsRouteAccessInput
): Promise<DocsRouteAccessResult> {
  const mode = resolveDocsAuthMode(input.config);
  const requiresAuth = modeRequiresAuth({
    mode,
    route: input.route,
    isRoutePrivate: input.isRoutePrivate,
  });

  if (!requiresAuth) {
    return {
      mode,
      route: input.route,
      requiresAuth: false,
      allowed: true,
    };
  }

  const session =
    input.session !== undefined ? input.session : input.resolveSession ? await input.resolveSession() : undefined;

  if (session == null) {
    throw createDocsError({
      code: "DOCS_AUTH_REQUIRED",
      message: `authentication is required for route ${input.route}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_AUTH_REQUIRED",
          message: `authentication is required for route ${input.route}`,
          details: {
            route: input.route,
            mode,
          },
        }),
      ],
    });
  }

  if (input.authorize) {
    const allowed = await input.authorize({
      route: input.route,
      session,
    });
    if (!allowed) {
      throw createDocsError({
        code: "DOCS_AUTH_FORBIDDEN",
        message: `access is forbidden for route ${input.route}`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_AUTH_FORBIDDEN",
            message: `access is forbidden for route ${input.route}`,
            details: {
              route: input.route,
              mode,
            },
          }),
        ],
      });
    }
  }

  return {
    mode,
    route: input.route,
    requiresAuth: true,
    allowed: true,
  };
}
