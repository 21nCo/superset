import { dirname, extname } from "node:path";
import { createDiagnostic, createDocsError } from "./diagnostics";
import { extractHeadings } from "./markdown";
import {
  buildRoute,
  normalizeSlug,
  slugToSegments,
  stripSourceExtension,
} from "./routing";
import {
  getNamedCollectionId,
  isNamedCollection,
  normalizeDatedCollectionId,
} from "./provider";
import type {
  DocsCollection,
  DocsConfig,
  DocsSourceEntry,
  DocsSourceEntryType,
} from "./types";

export interface MetaPageRule {
  key: string;
  label?: string;
  icon?: string;
  badge?: string;
  description?: string;
  expanded?: boolean;
  hidden?: boolean;
}

export interface MetaDocument {
  directory: string;
  title?: string;
  description?: string;
  root?: boolean;
  pages: MetaPageRule[];
}

export interface NormalizedPageRecord {
  id: string;
  collection: "docs" | "pages";
  sourcePath: string;
  sourceDirectory: string;
  sourceName: string;
  slug: string;
  path: string;
  version?: string;
  title: string;
  description?: string;
  body: string;
  headings: Array<{ level: number; text: string; slug: string }>;
  frontmatter: Record<string, any>;
}

export interface NormalizedPostRecord {
  id: string;
  collectionId?: string;
  collectionLabel?: string;
  searchScope?: string;
  slug: string;
  path: string;
  title: string;
  date: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, any>;
}

export interface NormalizedApiRecord {
  id: string;
  slug: string;
  path: string;
  title: string;
  body: string;
  frontmatter: Record<string, any>;
}

export interface NormalizedManifestInput {
  config: DocsConfig;
  entries: DocsSourceEntry[];
}

export interface NormalizedManifestData {
  pages: NormalizedPageRecord[];
  posts: NormalizedPostRecord[];
  apis: NormalizedApiRecord[];
  metaByDirectory: Map<string, MetaDocument>;
}

function shouldTreatAsContent(
  collection: DocsCollection,
  entryType: DocsSourceEntryType
): boolean {
  if (entryType !== "content") {
    return false;
  }
  return (
    collection === "docs" ||
    collection === "pages" ||
    collection === "blog" ||
    isNamedCollection(collection) ||
    collection === "api"
  );
}

function isDatedContentCollection(collection: DocsCollection): boolean {
  return collection === "blog" || isNamedCollection(collection);
}

function resolveDatedCollectionMetadata(
  collection: DocsCollection,
  config: DocsConfig
): { collectionId: string; collectionLabel?: string; searchScope?: string } {
  if (collection === "blog") {
    return {
      collectionId: "blog",
      collectionLabel: "Blog",
      searchScope: "blog",
    };
  }

  const collectionId = getNamedCollectionId(collection) ?? "collection";
  const collectionConfig = Object.entries(config.collections ?? {}).find(
    ([key]) => normalizeDatedCollectionId(key) === collectionId
  )?.[1];
  return {
    collectionId,
    collectionLabel: collectionConfig?.label,
    searchScope: collectionConfig?.scope ?? collectionId,
  };
}

function deriveTitleFromSourcePath(sourcePath: string): string {
  const segments = slugToSegments(sourcePath);
  const leaf = segments[segments.length - 1] ?? "untitled";
  const normalized = leaf === "index" && segments.length > 1 ? segments[segments.length - 2] : leaf;
  return normalized
    .split(/[-_]/g)
    .map((segment) =>
      segment.length > 0
        ? `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`
        : segment
    )
    .join(" ");
}

function parseMetaPageRule(value: unknown): MetaPageRule {
  if (typeof value === "string") {
    return {
      key: normalizeSlug(value),
    };
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keyCandidate =
      (typeof record.id === "string" && record.id) ||
      (typeof record.key === "string" && record.key) ||
      (typeof record.page === "string" && record.page) ||
      (typeof record.name === "string" && record.name);

    if (!keyCandidate) {
      throw new Error("meta.json page rule is missing a key/id/name");
    }

    return {
      key: normalizeSlug(keyCandidate),
      label:
        typeof record.label === "string"
          ? record.label
          : typeof record.title === "string"
            ? record.title
            : undefined,
      icon: typeof record.icon === "string" ? record.icon : undefined,
      badge: typeof record.badge === "string" ? record.badge : undefined,
      description:
        typeof record.description === "string" ? record.description : undefined,
      expanded:
        typeof record.expanded === "boolean" ? record.expanded : undefined,
      hidden: Boolean(record.hidden),
    };
  }

  throw new Error("meta.json pages entries must be strings or objects");
}

function parseMetaDocument(entry: DocsSourceEntry): MetaDocument {
  const raw = entry.body ?? "";
  const normalizedDirectory = normalizeSlug(dirname(entry.relativePath));
  const directory = normalizedDirectory === "." ? "" : normalizedDirectory;
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw createDocsError({
      code: "DOCS_META_INVALID",
      message: `invalid meta.json in ${entry.relativePath}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_META_INVALID",
          message: `invalid meta.json in ${entry.relativePath}`,
          location: { absolutePath: entry.absolutePath, sourceId: entry.id },
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      ],
      cause: error,
    });
  }

  const pagesValue = Array.isArray(parsed.pages) ? parsed.pages : [];
  const pages = pagesValue.map((value) => {
    try {
      return parseMetaPageRule(value);
    } catch (error) {
      throw createDocsError({
        code: "DOCS_META_INVALID",
        message: `invalid meta.json pages entry in ${entry.relativePath}`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_META_INVALID",
            message: `invalid meta.json pages entry in ${entry.relativePath}`,
            location: { absolutePath: entry.absolutePath, sourceId: entry.id },
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          }),
        ],
      });
    }
  });

  return {
    directory,
    title: typeof parsed.title === "string" ? parsed.title : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    root: Boolean(parsed.root),
    pages,
  };
}

export function normalizeSourceEntries(
  input: NormalizedManifestInput
): NormalizedManifestData {
  const pages: NormalizedPageRecord[] = [];
  const posts: NormalizedPostRecord[] = [];
  const apis: NormalizedApiRecord[] = [];
  const metaByDirectory = new Map<string, MetaDocument>();

  for (const entry of input.entries) {
    if (entry.collection === "docs" && entry.entryType === "control") {
      const parsedMeta = parseMetaDocument(entry);
      metaByDirectory.set(parsedMeta.directory, parsedMeta);
      continue;
    }

    if (!shouldTreatAsContent(entry.collection, entry.entryType)) {
      continue;
    }

    const extension = extname(entry.relativePath).toLowerCase();
    const sourcePath = stripSourceExtension(entry.relativePath);
    const sourceSegments = slugToSegments(sourcePath);
    const sourceName = sourceSegments[sourceSegments.length - 1] ?? "index";
    const sourceDirectory = sourceSegments.slice(0, -1).join("/");
    const frontmatter = entry.frontmatter ?? {};

    if (
      (entry.collection === "docs" ||
        entry.collection === "pages" ||
        isDatedContentCollection(entry.collection)) &&
      ![".md", ".mdx"].includes(extension)
    ) {
      continue;
    }
    if (entry.collection === "api" && ![".json", ".yaml", ".yml"].includes(extension)) {
      continue;
    }

    if (entry.collection === "docs" || entry.collection === "pages") {
      const route = buildRoute({
        collection: entry.collection,
        sourcePath,
        frontmatter,
        config: input.config,
      });

      const body = entry.body ?? "";
      pages.push({
        id: entry.id,
        collection: entry.collection,
        sourcePath,
        sourceDirectory,
        sourceName,
        slug: route.slug,
        path: route.path,
        version: route.version,
        title:
          typeof frontmatter.title === "string" && frontmatter.title.length > 0
            ? frontmatter.title
            : deriveTitleFromSourcePath(sourcePath),
        description:
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : undefined,
        body,
        headings: extractHeadings(body),
        frontmatter: frontmatter as Record<string, any>,
      });
      continue;
    }

    if (isDatedContentCollection(entry.collection)) {
      const route = buildRoute({
        collection: "blog",
        sourcePath,
        frontmatter,
        config: input.config,
      });
      const collectionMetadata = resolveDatedCollectionMetadata(entry.collection, input.config);
      posts.push({
        id: entry.id,
        collectionId: collectionMetadata.collectionId,
        collectionLabel: collectionMetadata.collectionLabel,
        searchScope: collectionMetadata.searchScope,
        slug: route.slug,
        path: route.path,
        title:
          typeof frontmatter.title === "string" && frontmatter.title.length > 0
            ? frontmatter.title
            : deriveTitleFromSourcePath(sourcePath),
        date:
          typeof frontmatter.date === "string" && frontmatter.date.length > 0
            ? frontmatter.date
            : "1970-01-01",
        tags: Array.isArray(frontmatter.tags)
          ? frontmatter.tags.filter((value) => typeof value === "string")
          : [],
        body: entry.body ?? "",
        frontmatter: frontmatter as Record<string, any>,
      });
      continue;
    }

    const route = buildRoute({
      collection: "api",
      sourcePath,
      frontmatter,
      config: input.config,
    });
    apis.push({
      id: entry.id,
      slug: route.slug,
      path: route.path,
      title:
        typeof frontmatter.title === "string" && frontmatter.title.length > 0
          ? frontmatter.title
          : deriveTitleFromSourcePath(sourcePath),
      body: entry.body ?? "",
      frontmatter: frontmatter as Record<string, any>,
    });
  }

  return {
    pages: pages.sort((left, right) =>
      left.path.localeCompare(right.path, "en", { sensitivity: "variant", numeric: true })
    ),
    posts: posts.sort((left, right) =>
      left.path.localeCompare(right.path, "en", { sensitivity: "variant", numeric: true })
    ),
    apis: apis.sort((left, right) =>
      left.path.localeCompare(right.path, "en", { sensitivity: "variant", numeric: true })
    ),
    metaByDirectory,
  };
}
