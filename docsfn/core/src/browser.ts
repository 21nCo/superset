/**
 * Browser-safe sub-entry for @docsfn/core.
 *
 * Exports only modules that are safe to import in client-side (browser) code.
 * Does NOT export anything from config.ts, provider.ts, manifest.ts, routing.ts,
 * normalize.ts, rss.ts, blog.ts, openapi.ts, or compile/react.ts — those modules
 * import node:* APIs and must remain server-only.
 */

// Pure types — no node:* imports
export type {
  ContentKind,
  Version,
  DocPage,
  BlogPost,
  BlogTagIndex,
  BlogArchivePage,
  BlogManifestSurface,
  EmbeddedPageRoute,
  EmbeddedManifestSurface,
  DocHeading,
  SidebarItem,
  Sidebar,
  ApiReference,
  DocsManifest,
  RawContentEntry,
  DocsFramework,
  DocsCollection,
  DocsVersionMode,
  DocsCompatPreset,
  DocsSiteConfig,
  DocsVersionConfig,
  DocsTopNavItem,
  DocsSidebarDefinition,
  DocsSearchScope,
  DocsSearchRouteScopeOverride,
  DocsSearchConfig,
  CompiledHeadingBlock,
  CompiledParagraphBlock,
  CompiledListBlock,
  CompiledTableBlock,
  CompiledCodeBlock,
  CompiledMermaidBlock,
  CompiledCalloutBlock,
  CompiledTabsTab,
  CompiledTabsBlock,
  CompiledComponentBlock,
  CompiledContentBlock,
  CompiledContentArtifact,
  DocsConfig,
  DocsErrorCode,
  DocsDiagnostic,
} from "./types";

// Diagnostics utilities — no node:* imports
export {
  DocsError,
  createDiagnostic,
  createDocsError,
  hasErrorDiagnostics,
  redactDiagnostics,
  formatDiagnosticsForCli,
  diagnosticsFromUnknownError,
  assertNoErrorDiagnostics,
  normalizeDocsErrorCode,
  CANONICAL_DOCS_ERROR_CODES,
} from "./diagnostics";

export type {
  LegacyDocsErrorCode,
  AnyDocsErrorCode,
  CreateDiagnosticInput,
} from "./diagnostics";

// Sanitize utilities — no node:* imports
export {
  BLOCKED_HTML_TAGS,
  BLOCKED_HTML_PATTERNS,
  findUnsafeHtml,
  assertSafeSource,
} from "./sanitize";

export type {
  SanitizeSourceInput,
  UnsafeHtmlMatch,
} from "./sanitize";

// Markdown compiler and block types — no node:* imports
export {
  compileMarkdown,
  extractHeadings,
} from "./markdown";

export type {
  CompileMarkdownInput,
} from "./markdown";

export {
  resolveMarkdownRelativeLinks,
} from "./links";

export type {
  ResolveMarkdownRelativeLinksInput,
} from "./links";

// Svelte compile helper — thin wrapper around compileMarkdown, no node:*
export { compileSvelteContent } from "./compile/svelte";

// React compile helper — thin wrapper around compileMarkdown, no node:*
export { compileReactContent } from "./compile/react";

// Security utilities that are browser-compatible
// (assertCompiledContentTrusted uses process.env which is available via Vite/Webpack)
export {
  assertCompiledContentTrusted,
  assertSourceEntriesTrusted,
  collectUnsafeHtmlDiagnostics,
  resolveUnsafeHtmlAllowlist,
  resolveDocsAuthMode,
  redactSensitiveText,
  redactSensitivePayload,
  CANONICAL_DOCS_AUTH_MODES,
} from "./security";

export type {
  DocsAuthMode,
  ResolveUnsafeHtmlAllowlistInput,
  SourceTrustPolicy,
  AssertSourceEntriesTrustedInput,
  AssertCompiledContentTrustedInput,
  AssertDocsRouteAccessInput,
  DocsRouteAccessResult,
} from "./security";

// Theme utilities — no node:* imports
export {
  generateThemeCSS,
  defaultLightTheme,
  defaultDarkTheme,
} from "./theme";

export type {
  ThemeConfig,
  DocsTheme,
} from "./theme";
