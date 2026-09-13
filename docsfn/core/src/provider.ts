import { createHash } from "node:crypto";
import { posix } from "node:path";
import { createDiagnostic, createDocsError } from "./diagnostics";
import type {
  DocsCollection,
  DocsConfig,
  DocsDiagnostic,
  RawContentEntry,
} from "./types";

export type DocsSourceEntryType = "content" | "control" | "asset";

export interface DocsSourceEntry {
  id: string;
  collection: DocsCollection;
  relativePath: string;
  absolutePath?: string;
  entryType: DocsSourceEntryType;
  frontmatter: Record<string, unknown>;
  body?: string;
  bytes?: number;
  sha256?: string;
  etag?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface DocsProviderListEntriesInput {
  config: DocsConfig;
  collections: DocsCollection[];
}

export interface DocsProviderLoadEntryInput {
  config: DocsConfig;
  entry: DocsSourceEntry;
}

export interface DocsProviderLoadAssetResult {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  sha256?: string;
}

export interface DocsProviderWatchMetadata {
  watchedFiles: string[];
  watchedDirectories: string[];
  collectionGlobs: Partial<Record<DocsCollection, string[]>>;
}

export interface DocsProviderWatchInput {
  config: DocsConfig;
  onChange: (paths: string[]) => Promise<void> | void;
  collections?: DocsCollection[];
}

export interface DocsProviderWatchSubscription {
  metadata: DocsProviderWatchMetadata;
  close(): Promise<void>;
}

export interface DocsContentProvider {
  readonly providerId: string;
  listEntries(input: DocsProviderListEntriesInput): Promise<DocsSourceEntry[]>;
  loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry>;
  loadAsset?(input: {
    config: DocsConfig;
    relativePath: string;
  }): Promise<DocsProviderLoadAssetResult>;
  watch?(input: DocsProviderWatchInput): Promise<DocsProviderWatchSubscription>;
  list(): Promise<RawContentEntry[]>;
}

export function normalizeProviderPath(inputPath: string): string {
  return inputPath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
}

export function createSourceEntryId(
  collection: DocsCollection,
  relativePath: string
): string {
  return `${collection}:${normalizeProviderPath(relativePath)}`;
}

export function normalizeDatedCollectionId(value: string): string {
  return normalizeProviderPath(value)
    .replaceAll("/", "-")
    .trim()
    .toLowerCase();
}

export function createNamedCollection(collectionId: string): DocsCollection {
  return `collection:${normalizeDatedCollectionId(collectionId)}`;
}

export function isNamedCollection(collection: DocsCollection): collection is `collection:${string}` {
  return collection.startsWith("collection:");
}

export function getNamedCollectionId(collection: DocsCollection): string | undefined {
  if (!isNamedCollection(collection)) {
    return undefined;
  }
  const id = collection.slice("collection:".length);
  return id.length > 0 ? id : undefined;
}

export function stableSortSourceEntries(entries: DocsSourceEntry[]): DocsSourceEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = `${left.collection}:${normalizeProviderPath(left.relativePath)}`;
    const rightKey = `${right.collection}:${normalizeProviderPath(right.relativePath)}`;
    return leftKey.localeCompare(rightKey, "en", {
      sensitivity: "variant",
      numeric: true,
    });
  });
}

export function assertUniqueSourceEntryIds(entries: DocsSourceEntry[]): void {
  const seen = new Map<string, DocsSourceEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.id);
    if (existing) {
      throw createDocsError({
        code: "DOCS_PROVIDER_ERROR",
        message: `provider emitted duplicate source entry id ${entry.id}`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_PROVIDER_ERROR",
            message: `provider emitted duplicate source entry id ${entry.id}`,
            details: {
              duplicateId: entry.id,
              firstPath: existing.relativePath,
              secondPath: entry.relativePath,
            },
          }),
        ],
      });
    }
    seen.set(entry.id, entry);
  }
}

export function validateSourceEntries(entries: DocsSourceEntry[]): DocsDiagnostic[] {
  const diagnostics: DocsDiagnostic[] = [];

  for (const entry of entries) {
    const normalizedRelativePath = normalizeProviderPath(entry.relativePath);
    if (!entry.id || entry.id.trim().length === 0) {
      diagnostics.push(
        createDiagnostic({
          code: "DOCS_PROVIDER_ERROR",
          message: "provider entry id is required",
          location: { absolutePath: entry.absolutePath },
        })
      );
    }

    if (!entry.collection) {
      diagnostics.push(
        createDiagnostic({
          code: "DOCS_PROVIDER_ERROR",
          message: `provider entry ${entry.id} is missing collection`,
          location: { absolutePath: entry.absolutePath },
        })
      );
    }

    if (normalizedRelativePath.length === 0) {
      diagnostics.push(
        createDiagnostic({
          code: "DOCS_PROVIDER_ERROR",
          message: `provider entry ${entry.id} has empty relativePath`,
          location: { absolutePath: entry.absolutePath },
        })
      );
    }

    if (entry.relativePath !== normalizedRelativePath) {
      diagnostics.push(
        createDiagnostic({
          code: "DOCS_PROVIDER_ERROR",
          severity: "warning",
          message: `provider entry ${entry.id} relativePath is not normalized`,
          location: { absolutePath: entry.absolutePath },
          details: {
            actual: entry.relativePath,
            normalized: normalizedRelativePath,
          },
        })
      );
    }
  }

  return diagnostics;
}

export function assertValidSourceEntries(entries: DocsSourceEntry[]): DocsSourceEntry[] {
  assertUniqueSourceEntryIds(entries);
  const diagnostics = validateSourceEntries(entries);
  const errorDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (errorDiagnostics.length > 0) {
    throw createDocsError({
      code: "DOCS_PROVIDER_ERROR",
      message: "provider entries failed validation",
      diagnostics: errorDiagnostics,
    });
  }

  return stableSortSourceEntries(entries);
}

export function createProviderError(input: {
  message: string;
  absolutePath?: string;
  details?: Record<string, unknown>;
}) {
  return createDocsError({
    code: "DOCS_PROVIDER_ERROR",
    message: input.message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_PROVIDER_ERROR",
        message: input.message,
        location: { absolutePath: input.absolutePath },
        details: input.details,
      }),
    ],
  });
}

export function createProviderRemoteFetchError(input: {
  message: string;
  absolutePath?: string;
  details?: Record<string, unknown>;
}) {
  return createDocsError({
    code: "DOCS_REMOTE_FETCH_FAILED",
    message: input.message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_REMOTE_FETCH_FAILED",
        message: input.message,
        location: { absolutePath: input.absolutePath },
        details: input.details,
      }),
    ],
  });
}

export function sha256FromBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeToPosixPath(value: string): string {
  return posix.normalize(normalizeProviderPath(value));
}

export function toLegacyRawEntries(entries: DocsSourceEntry[]): RawContentEntry[] {
  return stableSortSourceEntries(entries)
    .filter((entry) => entry.entryType !== "control")
    .map((entry) => {
      const kind =
        entry.collection === "api"
          ? "api"
          : entry.collection === "blog" || isNamedCollection(entry.collection)
            ? "post"
            : entry.collection === "assets"
              ? "asset"
              : "page";

      return {
        id: normalizeProviderPath(entry.relativePath),
        kind,
        body: entry.body ?? "",
        frontmatter: entry.frontmatter,
        filepath: entry.absolutePath,
      } as RawContentEntry;
    });
}
