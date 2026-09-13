import type { DocsDiagnostic, DocsErrorCode } from "./types";

export type LegacyDocsErrorCode =
  | "DOCS_PROVIDER_INVALID"
  | "DOCS_ROUTE_INVALID"
  | "DOCS_COMPILE_FAILED"
  | "DOCS_SEARCH_FAILED";

export type AnyDocsErrorCode = DocsErrorCode | LegacyDocsErrorCode;

const LEGACY_ERROR_CODE_MAP: Record<LegacyDocsErrorCode, DocsErrorCode> = {
  DOCS_PROVIDER_INVALID: "DOCS_PROVIDER_ERROR",
  DOCS_ROUTE_INVALID: "DOCS_ROUTE_NOT_FOUND",
  DOCS_COMPILE_FAILED: "DOCS_MDX_COMPILE_FAILED",
  DOCS_SEARCH_FAILED: "DOCS_SEARCH_BUILD_FAILED",
};

export const CANONICAL_DOCS_ERROR_CODES: DocsErrorCode[] = [
  "DOCS_CONFIG_INVALID",
  "DOCS_CONFIG_UNSUPPORTED",
  "DOCS_PROVIDER_ERROR",
  "DOCS_ENTRY_INVALID",
  "DOCS_META_INVALID",
  "DOCS_ROUTE_CONFLICT",
  "DOCS_ROUTE_NOT_FOUND",
  "DOCS_VERSION_INVALID",
  "DOCS_COMPAT_UNSUPPORTED",
  "DOCS_COMPONENT_UNRESOLVED",
  "DOCS_MDX_COMPILE_FAILED",
  "DOCS_HTML_UNSAFE",
  "DOCS_SEARCH_BUILD_FAILED",
  "DOCS_SEARCH_SCOPE_INVALID",
  "DOCS_OPENAPI_PARSE_FAILED",
  "DOCS_REMOTE_FETCH_FAILED",
  "DOCS_AUTH_REQUIRED",
  "DOCS_AUTH_FORBIDDEN",
  "DOCS_ARTIFACT_INVALID",
];

export function normalizeDocsErrorCode(code: AnyDocsErrorCode): DocsErrorCode {
  if (code in LEGACY_ERROR_CODE_MAP) {
    return LEGACY_ERROR_CODE_MAP[code as LegacyDocsErrorCode];
  }

  return code as DocsErrorCode;
}

export interface CreateDiagnosticInput {
  code: AnyDocsErrorCode;
  severity?: DocsDiagnostic["severity"];
  message: string;
  location?: DocsDiagnostic["location"];
  details?: DocsDiagnostic["details"];
  suggestion?: DocsDiagnostic["suggestion"];
}

export function createDiagnostic(input: CreateDiagnosticInput): DocsDiagnostic {
  return {
    code: normalizeDocsErrorCode(input.code),
    severity: input.severity ?? "error",
    message: input.message,
    location: input.location,
    details: input.details,
    suggestion: input.suggestion,
  };
}

export class DocsError extends Error {
  code: DocsErrorCode;
  diagnostics: DocsDiagnostic[];

  constructor(input: {
    code: AnyDocsErrorCode;
    message: string;
    diagnostics: DocsDiagnostic[];
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "DocsError";
    this.code = normalizeDocsErrorCode(input.code);
    this.diagnostics = input.diagnostics;
  }
}

export function createDocsError(input: {
  code: AnyDocsErrorCode;
  message: string;
  diagnostics?: DocsDiagnostic[];
  cause?: unknown;
}): DocsError {
  const diagnostics =
    input.diagnostics && input.diagnostics.length > 0
      ? input.diagnostics
      : [createDiagnostic({ code: input.code, message: input.message })];

  return new DocsError({
    code: input.code,
    message: input.message,
    diagnostics,
    cause: input.cause,
  });
}

export function hasErrorDiagnostics(diagnostics: DocsDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

const SENSITIVE_DETAIL_KEY_PATTERN =
  /(secret|token|cookie|authorization|password|passwd|api[-_]?key|private[-_]?key|raw[-_]?body|raw[-_]?content|session)/i;

const SENSITIVE_DETAIL_VALUE_PATTERN =
  /(bearer\s+[a-z0-9._-]+|xox[baprs]-[a-z0-9-]+|gh[pousr]_[a-z0-9]+|sk_[a-z0-9]+)/i;

function redactDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }

  if (typeof value === "string") {
    return SENSITIVE_DETAIL_VALUE_PATTERN.test(value) ? "[REDACTED]" : value;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DETAIL_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactDiagnosticValue(nested);
  }

  return output;
}

export function redactDiagnostics(
  diagnostics: DocsDiagnostic[]
): DocsDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    details:
      diagnostic.details === undefined
        ? undefined
        : (redactDiagnosticValue(diagnostic.details) as Record<string, unknown>),
  }));
}

export function formatDiagnosticsForCli(
  diagnostics: DocsDiagnostic[]
): string[] {
  return diagnostics.map((diagnostic) => {
    const locationParts: string[] = [];
    if (diagnostic.location?.sourceId) {
      locationParts.push(`source=${diagnostic.location.sourceId}`);
    }
    if (diagnostic.location?.absolutePath) {
      locationParts.push(`path=${diagnostic.location.absolutePath}`);
    }
    if (typeof diagnostic.location?.line === "number") {
      locationParts.push(`line=${diagnostic.location.line}`);
    }
    if (typeof diagnostic.location?.column === "number") {
      locationParts.push(`column=${diagnostic.location.column}`);
    }
    const locationSuffix =
      locationParts.length > 0 ? ` (${locationParts.join(", ")})` : "";
    return `[${diagnostic.severity.toUpperCase()}] ${diagnostic.code}: ${diagnostic.message}${locationSuffix}`;
  });
}

export function diagnosticsFromUnknownError(
  error: unknown,
  fallback: {
    code: AnyDocsErrorCode;
    message: string;
  }
): DocsDiagnostic[] {
  if (
    typeof error === "object" &&
    error !== null &&
    "diagnostics" in error &&
    Array.isArray((error as { diagnostics?: unknown }).diagnostics)
  ) {
    return (error as { diagnostics: DocsDiagnostic[] }).diagnostics;
  }

  return [
    createDiagnostic({
      code: fallback.code,
      message:
        error instanceof Error && error.message
          ? `${fallback.message}: ${error.message}`
          : fallback.message,
    }),
  ];
}

export function assertNoErrorDiagnostics(
  diagnostics: DocsDiagnostic[],
  message = "docsfn encountered diagnostics with error severity"
): void {
  if (!hasErrorDiagnostics(diagnostics)) {
    return;
  }

  const firstError =
    diagnostics.find((diagnostic) => diagnostic.severity === "error") ??
    diagnostics[0];

  throw createDocsError({
    code: firstError.code,
    message,
    diagnostics,
  });
}
