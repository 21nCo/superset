import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DocusaurusMigrateOptions {
  source: string;
  target: string;
  docsDir?: string;
  pagesDir?: string;
  changelogDir?: string;
  staticDir?: string;
  sidebarsPath?: string;
  sidebarId?: string;
  docsBasePath?: string;
  pagesBasePath?: string;
  changelogBasePath?: string;
  oldDocsBasePath?: string;
  oldPagesBasePath?: string;
  oldChangelogBasePath?: string;
  fromOrigin?: string;
  toOrigin?: string;
  onlySidebarDocs?: boolean;
  dryRun?: boolean;
}

export interface DocusaurusMigrateResult {
  sourceRoot: string;
  targetRoot: string;
  docsCopied: number;
  pagesCopied: number;
  changelogCopied: number;
  staticAssetsCopied: number;
  docAssetsCopied: number;
  metaFilesWritten: number;
  redirectsWritten: number;
  reportPath: string;
  warnings: string[];
}

interface Frontmatter {
  id?: string;
  slug?: string;
  title?: string;
  sidebarLabel?: string;
  sidebarPosition?: number;
  date?: string;
}

interface ContentRecord {
  kind: "doc" | "page" | "changelog";
  sourcePath: string;
  relativePath: string;
  targetPath: string;
  stem: string;
  id: string;
  title: string;
  frontmatter: Frontmatter;
  oldPath: string;
  newPath: string;
}

type DocusaurusSidebarItem =
  | string
  | {
      type?: string;
      id?: string;
      docId?: string;
      label?: string;
      href?: string;
      dirName?: string;
      link?: string | { type?: string; id?: string };
      items?: DocusaurusSidebarItem[];
    };

type MetaPageEntry = string | { key: string; label?: string };

interface MetaDocumentDraft {
  title?: string;
  pages: MetaPageEntry[];
}

interface RedirectRecord {
  from: string;
  to: string;
  status: 301;
  sourceKind: "docs" | "pages" | "changelog";
  sourcePath: string;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const CHANGELOG_DATE_LINE_REGEX =
  /^\s*<div\s+align=["']right["']>\s*\*([^*]+)\*\s*<\/div>\s*$/im;
const IFRAME_REGEX = /<iframe\b([\s\S]*?)>\s*<\/iframe>/gi;
const HTML_ATTRIBUTE_REGEX =
  /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,}$/;
const MONTH_NUMBERS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function ensureLeadingSlash(value: string): string {
  if (!value || value === ".") {
    return "/";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeRouteBase(value: string | undefined, fallback: string): string {
  return stripTrailingSlash(ensureLeadingSlash(value ?? fallback));
}

function joinRoute(basePath: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(basePath, "/");
  const cleanSlug = slug
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!cleanSlug || cleanSlug === "index") {
    return normalizedBase;
  }

  const withoutIndex = cleanSlug.endsWith("/index")
    ? cleanSlug.slice(0, -"/index".length)
    : cleanSlug;

  if (normalizedBase === "/") {
    return `/${withoutIndex}`;
  }
  return `${normalizedBase}/${withoutIndex}`;
}

function stripMarkdownExtension(relativePath: string): string {
  const parsed = path.posix.parse(normalizePath(relativePath));
  return normalizePath(path.posix.join(parsed.dir, parsed.name));
}

function titleFromSlug(slug: string): string {
  const base = slug.split("/").filter(Boolean).at(-1) ?? slug;
  const normalized = base === "index" ? "Overview" : base;
  return normalized
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function parseScalarFrontmatterValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(source: string): Frontmatter {
  if (!source.startsWith("---")) {
    return {};
  }

  const endIndex = source.indexOf("\n---", 3);
  if (endIndex < 0) {
    return {};
  }

  const frontmatterSource = source.slice(3, endIndex).trim();
  const frontmatter: Frontmatter = {};

  for (const line of frontmatterSource.split(/\r?\n/g)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = parseScalarFrontmatterValue(match[2]);
    if (key === "id") {
      frontmatter.id = value;
    } else if (key === "slug") {
      frontmatter.slug = value;
    } else if (key === "title") {
      frontmatter.title = value;
    } else if (key === "sidebar_label") {
      frontmatter.sidebarLabel = value;
    } else if (key === "sidebar_position") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        frontmatter.sidebarPosition = parsed;
      }
    } else if (key === "date") {
      frontmatter.date = value;
    }
  }

  return frontmatter;
}

function parseDisplayDate(value: string): string | undefined {
  const match = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) {
    return undefined;
  }

  const month = MONTH_NUMBERS[match[1].toLowerCase()];
  if (!month) {
    return undefined;
  }

  const day = match[2].padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

function inferDateFromMarkdown(source: string): string | undefined {
  const match = source.match(CHANGELOG_DATE_LINE_REGEX);
  return match ? parseDisplayDate(match[1]) : undefined;
}

function inferDateFromPath(relativePath: string): string | undefined {
  const dated = normalizePath(relativePath).match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:[-/.]|$)/)?.[1];
  if (dated) {
    const parsed = new Date(`${dated}T00:00:00Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dated) return dated;
  }
  const match = normalizePath(relativePath).match(/(?:^|\/)(\d{4})(?:\/|$)/);
  return match ? `${match[1]}-01-01` : undefined;
}

function removeDocusaurusDateLine(source: string): string {
  return source.replace(CHANGELOG_DATE_LINE_REGEX, "").replace(/\n{3,}/g, "\n\n");
}

function parseHtmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(HTML_ATTRIBUTE_REGEX)) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes[key] = value;
  }

  return attributes;
}

function extractYouTubeVideoId(src: string | undefined): string | undefined {
  if (!src) {
    return undefined;
  }

  try {
    const parsed = new URL(src);
    const hostname = parsed.hostname.toLowerCase();
    const isYouTubeHost =
      hostname === "youtube.com" ||
      hostname === "www.youtube.com" ||
      hostname === "youtube-nocookie.com" ||
      hostname === "www.youtube-nocookie.com";
    const match = parsed.pathname.match(/^\/embed\/([^/?#]+)/);
    const videoId = match?.[1];
    if (isYouTubeHost && videoId && YOUTUBE_VIDEO_ID_REGEX.test(videoId)) {
      return videoId;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function escapeMdxAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function transformYouTubeIframes(input: {
  source: string;
  relativePath: string;
  warnings?: string[];
}): string {
  return input.source.replace(IFRAME_REGEX, (iframeSource, attributeSource: string) => {
    const attributes = parseHtmlAttributes(attributeSource);
    const videoId = extractYouTubeVideoId(attributes.src);

    if (!videoId) {
      input.warnings?.push(
        `Could not convert iframe in ${input.relativePath}; leaving raw HTML for manual review.`
      );
      return iframeSource;
    }

    const title = attributes.title?.trim() || "YouTube video";
    return `<YouTube id="${videoId}" title="${escapeMdxAttribute(title)}" />`;
  });
}

function upsertFrontmatterValue(source: string, key: string, value: string): string {
  if (!source.startsWith("---")) {
    return `---\n${key}: ${value}\n---\n\n${source}`;
  }

  const endIndex = source.indexOf("\n---", 3);
  if (endIndex < 0) {
    return `---\n${key}: ${value}\n---\n\n${source}`;
  }

  const before = source.slice(0, endIndex);
  const after = source.slice(endIndex);
  const keyRegex = new RegExp(`^${key}:\\s*.*$`, "m");
  if (keyRegex.test(before)) {
    return `${before.replace(keyRegex, `${key}: ${value}`)}${after}`;
  }

  return `${before}\n${key}: ${value}${after}`;
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await fs.access(input);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }

  return files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

async function copyFileMaybe(input: {
  source: string;
  target: string;
  dryRun?: boolean;
}): Promise<void> {
  if (input.dryRun) {
    return;
  }
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  await fs.copyFile(input.source, input.target);
}

function resolveMaybeAbsolute(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function createContentRecord(input: {
  kind: "doc" | "page" | "changelog";
  sourceRoot: string;
  sourcePath: string;
  targetRoot: string;
  targetCollectionDir: string;
  oldBasePath: string;
  newBasePath: string;
}): ContentRecord {
  const relativePath = normalizePath(path.relative(input.sourceRoot, input.sourcePath));
  const stem = stripMarkdownExtension(relativePath);
  const source = input.sourcePath;
  return {
    kind: input.kind,
    sourcePath: source,
    relativePath,
    targetPath: path.join(input.targetCollectionDir, relativePath),
    stem,
    id: stem,
    title: titleFromSlug(stem),
    frontmatter: {},
    oldPath: joinRoute(input.oldBasePath, stem),
    newPath: joinRoute(input.newBasePath, stem),
  };
}

async function readContentRecord(input: {
  kind: "doc" | "page" | "changelog";
  sourceRoot: string;
  sourcePath: string;
  targetCollectionDir: string;
  oldBasePath: string;
  newBasePath: string;
}): Promise<ContentRecord> {
  const source = await fs.readFile(input.sourcePath, "utf8");
  const frontmatter = parseFrontmatter(source);
  const baseRecord = createContentRecord({
    kind: input.kind,
    sourceRoot: input.sourceRoot,
    sourcePath: input.sourcePath,
    targetRoot: input.targetCollectionDir,
    targetCollectionDir: input.targetCollectionDir,
    oldBasePath: input.oldBasePath,
    newBasePath: input.newBasePath,
  });
  const docusaurusSlug = frontmatter.slug
    ? frontmatter.slug.replace(/^\/+/, "")
    : baseRecord.stem;

  return {
    ...baseRecord,
    id: frontmatter.id ?? baseRecord.stem,
    title: frontmatter.sidebarLabel ?? frontmatter.title ?? baseRecord.title,
    frontmatter,
    oldPath: joinRoute(input.oldBasePath, docusaurusSlug),
    newPath: joinRoute(input.newBasePath, baseRecord.stem),
  };
}

function redirectTarget(input: {
  path: string;
  origin?: string;
}): string {
  if (!input.origin) {
    return input.path;
  }
  return `${stripTrailingSlash(input.origin)}${input.path}`;
}

function createRedirects(input: {
  records: ContentRecord[];
  fromOrigin?: string;
  toOrigin?: string;
}): RedirectRecord[] {
  return input.records.map((record) => ({
    from: redirectTarget({ path: record.oldPath, origin: input.fromOrigin }),
    to: redirectTarget({ path: record.newPath, origin: input.toOrigin }),
    status: 301,
    sourceKind:
      record.kind === "doc" ? "docs" : record.kind === "page" ? "pages" : "changelog",
    sourcePath: record.relativePath,
  }));
}

function stringifyRedirects(redirects: RedirectRecord[]): string {
  return redirects
    .map((redirect) => `${redirect.from} ${redirect.to} ${redirect.status}`)
    .join("\n")
    .concat(redirects.length > 0 ? "\n" : "");
}

function extractDefaultExport(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    Object.keys(value as Record<string, unknown>).length === 1
  ) {
    return (value as { default: unknown }).default;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof (value as { default: unknown }).default === "object"
  ) {
    return (value as { default: unknown }).default;
  }
  return value;
}

function normalizeSidebarsSource(source: string): string {
  return source
    .replace(/^import\s+type\s+.*$/gm, "")
    .replace(
      /^import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["'];?$/gm,
      (_match, imports: string, specifier: string) =>
        `const { ${imports.trim()} } = __loadImport(${JSON.stringify(specifier)});`
    )
    .replace(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/g, "exports.$1 =")
    .replace(/const\s+([A-Za-z0-9_$]+)\s*:\s*[^=]+=/g, "const $1 =")
    .replace(/export\s+default\s+([A-Za-z0-9_$]+)\s*;?/g, "module.exports = $1;")
    .replace(/export\s+default\s+({[\s\S]*})\s*;?\s*$/g, "module.exports = $1;");
}

async function loadSidebarsFromText(sidebarsPath: string): Promise<unknown> {
  function resolveImport(fromPath: string, specifier: string): string {
    const base = path.resolve(path.dirname(fromPath), specifier);
    const candidates = path.extname(base)
      ? [base]
      : [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.ts`];

    const resolved = candidates.find((candidate) => fsSync.existsSync(candidate));
    if (!resolved) {
      throw new Error(`Could not resolve sidebar import "${specifier}" from ${normalizePath(fromPath)}.`);
    }
    return resolved;
  }

  function evaluate(filePath: string, seen = new Set<string>()): unknown {
    const resolvedPath = path.resolve(filePath);
    if (seen.has(resolvedPath)) {
      throw new Error(`Circular sidebar import detected at ${normalizePath(resolvedPath)}.`);
    }

    seen.add(resolvedPath);
    const raw = fsSync.readFileSync(resolvedPath, "utf8");
    const transformed = normalizeSidebarsSource(raw);
    const moduleValue = { exports: {} as unknown };
    const loadImport = (specifier: string) =>
      evaluate(resolveImport(resolvedPath, specifier), new Set(seen));
    const fn = new Function(
      "module",
      "exports",
      "__loadImport",
      `${transformed}\nreturn module.exports;`
    );
    return fn(moduleValue, moduleValue.exports, loadImport);
  }

  return evaluate(sidebarsPath);
}

async function loadDocusaurusSidebars(input: {
  sourceRoot: string;
  sidebarsPath?: string;
  warnings: string[];
}): Promise<Record<string, DocusaurusSidebarItem[]> | undefined> {
  const candidates = input.sidebarsPath
    ? [resolveMaybeAbsolute(input.sourceRoot, input.sidebarsPath)]
    : ["sidebars.js", "sidebars.cjs", "sidebars.mjs", "sidebars.ts"].map((file) =>
        path.resolve(input.sourceRoot, file)
      );

  let resolvedPath: string | undefined;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      resolvedPath = candidate;
      break;
    }
  }

  if (!resolvedPath) {
    input.warnings.push("No Docusaurus sidebars file found; meta.json order was inferred from files.");
    return undefined;
  }

  try {
    const loaded = await import(pathToFileURL(resolvedPath).href);
    const sidebars = extractDefaultExport(loaded);
    if (isSidebarConfig(sidebars)) {
      return sidebars;
    }
  } catch {
    // Fall through to text evaluation below. This helps common sidebars.ts files.
  }

  try {
    const loaded = await loadSidebarsFromText(resolvedPath);
    const sidebars = extractDefaultExport(loaded);
    if (isSidebarConfig(sidebars)) {
      return sidebars;
    }
  } catch (error) {
    input.warnings.push(
      `Could not load ${normalizePath(path.relative(input.sourceRoot, resolvedPath))}; meta.json order was inferred from files.`
    );
    if (error instanceof Error && error.message) {
      input.warnings.push(`Sidebar load error: ${error.message}`);
    }
  }

  return undefined;
}

function isSidebarConfig(value: unknown): value is Record<string, DocusaurusSidebarItem[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => Array.isArray(entry));
}

function isSidebarObject(value: DocusaurusSidebarItem): value is Exclude<DocusaurusSidebarItem, string> {
  return typeof value === "object" && value !== null;
}

function resolveDocId(item: DocusaurusSidebarItem): string | undefined {
  if (typeof item === "string") {
    return item;
  }
  if (item.type === "doc" && item.id) {
    return item.id;
  }
  if (item.type === "ref" && item.id) {
    return item.id;
  }
  if (item.docId) {
    return item.docId;
  }
  if (typeof item.link === "object" && item.link?.type === "doc" && item.link.id) {
    return item.link.id;
  }
  return undefined;
}

function getAutogeneratedRecords(
  item: DocusaurusSidebarItem,
  records: ContentRecord[]
): ContentRecord[] {
  if (!isSidebarObject(item) || item.type !== "autogenerated") {
    return [];
  }
  const dirName = normalizePath(item.dirName ?? "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
  if (!dirName) {
    return records;
  }
  return records.filter(
    (record) => record.stem === dirName || record.stem.startsWith(`${dirName}/`)
  );
}

function collectDocIds(item: DocusaurusSidebarItem, records: ContentRecord[]): string[] {
  if (isSidebarObject(item) && item.type === "autogenerated") {
    return getAutogeneratedRecords(item, records).map((record) => record.id);
  }
  const direct = resolveDocId(item);
  const childIds =
    isSidebarObject(item) && Array.isArray(item.items)
      ? item.items.flatMap((child) => collectDocIds(child, records))
      : [];
  if (direct) {
    return [direct, ...childIds];
  }
  return childIds;
}

function commonFirstSegment(ids: string[]): string | undefined {
  const firstSegments = ids
    .map((id) => normalizePath(id).split("/").filter(Boolean)[0])
    .filter(Boolean);
  if (firstSegments.length === 0) {
    return undefined;
  }
  const first = firstSegments[0];
  return firstSegments.every((segment) => segment === first) ? first : undefined;
}

function entryKey(entry: MetaPageEntry): string {
  return typeof entry === "string" ? entry : entry.key;
}

function addMetaEntry(meta: MetaDocumentDraft, entry: MetaPageEntry): void {
  const key = entryKey(entry);
  if (meta.pages.some((existing) => entryKey(existing) === key)) {
    return;
  }
  meta.pages.push(entry);
}

function ensureMeta(metaByDir: Map<string, MetaDocumentDraft>, dir: string): MetaDocumentDraft {
  const normalizedDir = normalizePath(dir).replace(/^\/+|\/+$/g, "");
  const existing = metaByDir.get(normalizedDir);
  if (existing) {
    return existing;
  }
  const created: MetaDocumentDraft = {
    pages: [],
  };
  metaByDir.set(normalizedDir, created);
  return created;
}

function maybeEntryWithLabel(key: string, label?: string): MetaPageEntry {
  if (label && label.trim().length > 0 && label.trim() !== titleFromSlug(key)) {
    return {
      key,
      label: label.trim(),
    };
  }
  return key;
}

function addRecordToMeta(input: {
  record: ContentRecord;
  metaByDir: Map<string, MetaDocumentDraft>;
  label?: string;
}): void {
  const segments = normalizePath(input.record.stem).split("/").filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  let currentDir = "";
  for (let index = 0; index < segments.length; index += 1) {
    const key = segments[index];
    const isLeaf = index === segments.length - 1;
    const meta = ensureMeta(input.metaByDir, currentDir);
    const entryLabel = isLeaf ? input.label ?? input.record.title : undefined;
    addMetaEntry(meta, maybeEntryWithLabel(key, entryLabel));
    if (!isLeaf) {
      currentDir = normalizePath(path.posix.join(currentDir, key));
      ensureMeta(input.metaByDir, currentDir);
    }
  }
}

function buildRecordIndexes(records: ContentRecord[]): {
  byId: Map<string, ContentRecord>;
  byStem: Map<string, ContentRecord>;
} {
  const byId = new Map<string, ContentRecord>();
  const byStem = new Map<string, ContentRecord>();
  for (const record of records) {
    byId.set(normalizePath(record.id), record);
    byStem.set(normalizePath(record.stem), record);
  }
  return { byId, byStem };
}

function buildMetaFromRecords(records: ContentRecord[]): Map<string, MetaDocumentDraft> {
  const metaByDir = new Map<string, MetaDocumentDraft>();
  const ordered = [...records].sort((left, right) => {
    const leftPosition = left.frontmatter.sidebarPosition ?? Number.POSITIVE_INFINITY;
    const rightPosition = right.frontmatter.sidebarPosition ?? Number.POSITIVE_INFINITY;
    if (leftPosition !== rightPosition) {
      return leftPosition - rightPosition;
    }
    return left.stem.localeCompare(right.stem, "en", { sensitivity: "variant", numeric: true });
  });

  for (const record of ordered) {
    addRecordToMeta({
      record,
      metaByDir,
      label: record.frontmatter.sidebarLabel ?? record.frontmatter.title,
    });
  }

  return metaByDir;
}

function applySidebarItemsToMeta(input: {
  items: DocusaurusSidebarItem[];
  records: ContentRecord[];
  metaByDir: Map<string, MetaDocumentDraft>;
  warnings: string[];
}): void {
  const { byId, byStem } = buildRecordIndexes(input.records);

  function applyItem(item: DocusaurusSidebarItem): void {
    const docId = resolveDocId(item);
    if (docId) {
      const normalizedId = normalizePath(docId);
      const record = byId.get(normalizedId) ?? byStem.get(normalizedId);
      if (!record) {
        input.warnings.push(`Sidebar references missing doc id "${docId}".`);
        return;
      }
      addRecordToMeta({
        record,
        metaByDir: input.metaByDir,
        label: isSidebarObject(item) ? item.label : undefined,
      });
      if (!isSidebarObject(item) || !Array.isArray(item.items)) {
        return;
      }
    }

    if (!isSidebarObject(item)) {
      return;
    }

    if (item.type === "autogenerated") {
      for (const record of getAutogeneratedRecords(item, input.records)) {
        addRecordToMeta({
          record,
          metaByDir: input.metaByDir,
          label: record.frontmatter.sidebarLabel ?? record.frontmatter.title,
        });
      }
      return;
    }

    if (Array.isArray(item.items)) {
      const ids = item.items.flatMap((child) => collectDocIds(child, input.records));
      const categoryKey = item.dirName ?? (docId ? undefined : commonFirstSegment(ids));
      if (categoryKey && item.label) {
        const rootMeta = ensureMeta(input.metaByDir, "");
        addMetaEntry(rootMeta, maybeEntryWithLabel(categoryKey, item.label));
        const categoryMeta = ensureMeta(input.metaByDir, categoryKey);
        categoryMeta.title = item.label;
      }

      for (const child of item.items) {
        applyItem(child);
      }
    }
  }

  input.metaByDir.clear();
  for (const item of input.items) {
    applyItem(item);
  }
}

function filterRecordsToSidebar(input: {
  records: ContentRecord[];
  items: DocusaurusSidebarItem[];
}): ContentRecord[] {
  const { byId, byStem } = buildRecordIndexes(input.records);
  const selectedRecords = new Set<ContentRecord>();
  const ids = input.items.flatMap((item) => collectDocIds(item, input.records));

  for (const id of ids) {
    const normalizedId = normalizePath(id);
    const record = byId.get(normalizedId) ?? byStem.get(normalizedId);
    if (record) {
      selectedRecords.add(record);
    }
  }

  return input.records.filter((record) => selectedRecords.has(record));
}

async function writeMetaFiles(input: {
  targetDocsDir: string;
  metaByDir: Map<string, MetaDocumentDraft>;
  dryRun?: boolean;
}): Promise<number> {
  let count = 0;
  const entries = [...input.metaByDir.entries()].sort(([left], [right]) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );

  for (const [dir, meta] of entries) {
    if (meta.pages.length === 0) {
      continue;
    }
    const targetPath = path.join(input.targetDocsDir, dir, "meta.json");
    const body = JSON.stringify(
      {
        ...(meta.title ? { title: meta.title } : {}),
        pages: meta.pages,
      },
      null,
      2
    );
    if (!input.dryRun) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, `${body}\n`, "utf8");
    }
    count += 1;
  }

  return count;
}

function generateDocsfnConfig(input: {
  docsBasePath: string;
  changelogBasePath: string;
}): string {
  return `import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "Migrated docs",
    description: "Migrated from Docusaurus to docsfn",
    basePath: "${input.docsBasePath}",
  },
  compat: { preset: "none" },
  content: {
    root: ".",
    docsDir: "content/docs",
    blogDir: "content/blog",
    apiDir: "content/api",
    pagesDir: "content/pages",
    assetsDir: "static",
    metaFileName: "meta.json",
  },
  navigation: {
    topNav: [
      { label: "Docs", href: "${input.docsBasePath}" },
      { label: "Changelog", href: "${input.changelogBasePath}" },
    ],
    sidebars: {
      docs: { title: "Docs", root: true, include: ["docs/**"] },
    },
  },
  collections: {
    changelog: {
      dir: "content/changelog",
      routeBase: "${input.changelogBasePath}",
      feedPath: "${input.changelogBasePath}/rss.xml",
      label: "Changelog",
      scope: "changelog",
    },
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog", "changelog"],
    bodyIndexing: "summary",
  },
  auth: { enabled: false, mode: "public" },
  analytics: { enabled: false, provider: "watchfn", respectDnt: true },
};

export default config;
`;
}

function generateReport(input: {
  result: Omit<DocusaurusMigrateResult, "reportPath">;
  redirects: RedirectRecord[];
  docsBasePath: string;
  pagesBasePath: string;
  changelogBasePath: string;
  oldDocsBasePath: string;
  oldPagesBasePath: string;
  oldChangelogBasePath: string;
}): string {
  const redirectSample = input.redirects
    .slice(0, 12)
    .map((redirect) => `| ${redirect.from} | ${redirect.to} |`)
    .join("\n");

  const warnings =
    input.result.warnings.length > 0
      ? input.result.warnings.map((warning) => `- ${warning}`).join("\n")
      : "- No warnings.";

  return `# Docusaurus to docsfn Migration Report

## Summary

- Docs copied: ${input.result.docsCopied}
- Pages copied: ${input.result.pagesCopied}
- Changelog entries copied: ${input.result.changelogCopied}
- Static assets copied: ${input.result.staticAssetsCopied}
- Docs-local assets copied to static/docs-assets: ${input.result.docAssetsCopied}
- meta.json files written: ${input.result.metaFilesWritten}
- Redirects written: ${input.result.redirectsWritten}

## Route Mapping

- Old docs base: \`${input.oldDocsBasePath}\`
- New docs base: \`${input.docsBasePath}\`
- Old pages base: \`${input.oldPagesBasePath}\`
- New pages base: \`${input.pagesBasePath}\`
- Old changelog base: \`${input.oldChangelogBasePath}\`
- New changelog base: \`${input.changelogBasePath}\`

| From | To |
| --- | --- |
${redirectSample || "| n/a | n/a |"}

## Files Created

- \`content/docs/**\`
- \`content/pages/**\`
- \`content/changelog/**\`
- \`static/**\`
- \`docsfn.config.migration.ts\`
- \`.docsfn-migration/redirects.json\`
- \`.docsfn-migration/cloudflare-redirects.txt\`

## Manual Checklist

- Check every relative image link copied from Docusaurus docs.
- Check migrated product pages such as FAQs and roadmap.
- Merge \`docsfn.config.migration.ts\` into the product app's real \`docsfn.config.ts\`.
- Confirm sidebar labels/order in generated \`meta.json\` files.
- Move product-specific release notes into \`content/changelog\` if Docusaurus used a different changelog source.
- Add Cloudflare redirects from old subdomain URLs to product paths.
- Verify \`${input.docsBasePath}\`, \`${input.changelogBasePath}\`, \`${input.changelogBasePath}.json\`, and embed URLs.

## Warnings

${warnings}
`;
}

function rewriteColocatedAssets(source: string, record: ContentRecord): string {
  if (record.kind !== "doc") return source;
  const docsRoot = path.resolve(
    path.dirname(record.sourcePath),
    path.relative(path.dirname(record.relativePath), ".")
  );
  const rewrite = (href: string): string => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#?\\]/.test(href)) return href;
    const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/s)!;
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return href; }
    const target = path.resolve(path.dirname(record.sourcePath), decoded);
    const relative = path.relative(docsRoot, target);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      MARKDOWN_EXTENSIONS.has(path.extname(target))
    )
      return href;
    try {
      if (!fsSync.lstatSync(target).isFile()) return href;
      let parent = path.dirname(target);
      while (parent !== docsRoot) {
        if (fsSync.lstatSync(parent).isSymbolicLink()) return href;
        parent = path.dirname(parent);
      }
    } catch {
      return href;
    }
    return `/docs-assets/${normalizePath(relative).split("/").map(encodeURIComponent).join("/")}${suffix}`;
  };
  return source
    .replace(
      /(!?\[[^\]]*\]\()([^\s)]+)((?:\s+"[^"\n]*"|\s+'[^'\n]*')?\))/g,
      (_match, prefix, href, close) => `${prefix}${rewrite(href)}${close}`
    )
    .replace(
      /(\b(?:src|href)=["'])([^"']+)(["'])/g,
      (_match, prefix, href, close) => `${prefix}${rewrite(href)}${close}`
    );
}

async function copyContentRecords(input: {
  records: ContentRecord[];
  warnings?: string[];
  dryRun?: boolean;
}): Promise<number> {
  let copied = 0;
  for (const record of input.records) {
    const source = await fs.readFile(record.sourcePath, "utf8");
    const transformed = transformYouTubeIframes({
      source: rewriteColocatedAssets(source, record),
      relativePath: record.relativePath,
      warnings: input.warnings,
    });

    if (record.kind === "changelog" && !record.frontmatter.date) {
      const inferredDate =
        inferDateFromMarkdown(transformed) ?? inferDateFromPath(record.relativePath);
      if (inferredDate) {
        const withoutDocusaurusDateLine = removeDocusaurusDateLine(transformed);
        const migrated = upsertFrontmatterValue(withoutDocusaurusDateLine, "date", inferredDate);
        if (!input.dryRun) {
          await fs.mkdir(path.dirname(record.targetPath), { recursive: true });
          await fs.writeFile(record.targetPath, migrated, "utf8");
        }
      } else {
        input.warnings?.push(
          `Could not infer changelog date for ${record.relativePath}; copied without date metadata.`
        );
        if (!input.dryRun) {
          await fs.mkdir(path.dirname(record.targetPath), { recursive: true });
          await fs.writeFile(record.targetPath, transformed, "utf8");
        }
      }
    } else {
      if (!input.dryRun) {
        await fs.mkdir(path.dirname(record.targetPath), { recursive: true });
        await fs.writeFile(record.targetPath, transformed, "utf8");
      }
    }
    copied += 1;
  }
  return copied;
}

async function copyDirectoryFiles(input: {
  sourceDir: string;
  targetDir: string;
  filter?: (file: string) => boolean;
  dryRun?: boolean;
}): Promise<number> {
  const files = await listFilesRecursive(input.sourceDir);
  let copied = 0;
  for (const file of files) {
    if (input.filter && !input.filter(file)) {
      continue;
    }
    const relative = path.relative(input.sourceDir, file);
    await copyFileMaybe({
      source: file,
      target: path.join(input.targetDir, relative),
      dryRun: input.dryRun,
    });
    copied += 1;
  }
  return copied;
}

async function ensureContentDirectories(input: {
  targetRoot: string;
  dryRun?: boolean;
}): Promise<void> {
  if (input.dryRun) {
    return;
  }
  await Promise.all(
    ["content/docs", "content/changelog", "content/blog", "content/api", "content/pages", "static"].map(
      (dir) => fs.mkdir(path.join(input.targetRoot, dir), { recursive: true })
    )
  );
}

export async function migrateDocusaurus(input: DocusaurusMigrateOptions): Promise<DocusaurusMigrateResult> {
  const sourceRoot = path.resolve(input.source);
  const targetRoot = path.resolve(input.target);
  const docsDir = resolveMaybeAbsolute(sourceRoot, input.docsDir ?? "docs");
  const pagesDir = input.pagesDir ? resolveMaybeAbsolute(sourceRoot, input.pagesDir) : undefined;
  const changelogDir = resolveMaybeAbsolute(sourceRoot, input.changelogDir ?? "blog");
  const staticDir = resolveMaybeAbsolute(sourceRoot, input.staticDir ?? "static");
  const docsBasePath = normalizeRouteBase(input.docsBasePath, "/docs");
  const pagesBasePath = normalizeRouteBase(input.pagesBasePath, docsBasePath);
  const changelogBasePath = normalizeRouteBase(input.changelogBasePath, "/changelog");
  const oldDocsBasePath = normalizeRouteBase(input.oldDocsBasePath, "/");
  const oldPagesBasePath = normalizeRouteBase(input.oldPagesBasePath, "/");
  const oldChangelogBasePath = normalizeRouteBase(input.oldChangelogBasePath, "/changelog");
  const targetDocsDir = path.join(targetRoot, "content", "docs");
  const targetPagesDir = path.join(
    targetRoot,
    "content",
    "pages",
    pagesBasePath.replace(/^\/+/, "")
  );
  const targetChangelogDir = path.join(targetRoot, "content", "changelog");
  const targetStaticDir = path.join(targetRoot, "static");
  const migrationDir = path.join(targetRoot, ".docsfn-migration");
  const warnings: string[] = [];

  await ensureContentDirectories({
    targetRoot,
    dryRun: input.dryRun,
  });

  const docFiles = (await listFilesRecursive(docsDir)).filter((file) =>
    MARKDOWN_EXTENSIONS.has(path.extname(file))
  );
  const changelogFiles = (await listFilesRecursive(changelogDir)).filter((file) =>
    MARKDOWN_EXTENSIONS.has(path.extname(file))
  );
  const pageFiles = pagesDir
    ? (await listFilesRecursive(pagesDir)).filter((file) =>
        MARKDOWN_EXTENSIONS.has(path.extname(file))
      )
    : [];

  let docRecords = await Promise.all(
    docFiles.map((file) =>
      readContentRecord({
        kind: "doc",
        sourceRoot: docsDir,
        sourcePath: file,
        targetCollectionDir: targetDocsDir,
        oldBasePath: oldDocsBasePath,
        newBasePath: docsBasePath,
      })
    )
  );
  const changelogRecords = await Promise.all(
    changelogFiles.map((file) =>
      readContentRecord({
        kind: "changelog",
        sourceRoot: changelogDir,
        sourcePath: file,
        targetCollectionDir: targetChangelogDir,
        oldBasePath: oldChangelogBasePath,
        newBasePath: changelogBasePath,
      })
    )
  );
  const pageRecords = pagesDir
    ? await Promise.all(
        pageFiles.map((file) =>
          readContentRecord({
            kind: "page",
            sourceRoot: pagesDir,
            sourcePath: file,
            targetCollectionDir: targetPagesDir,
            oldBasePath: oldPagesBasePath,
            newBasePath: pagesBasePath,
          })
        )
      )
    : [];

  if (docRecords.length === 0) {
    warnings.push(`No Markdown docs found in ${normalizePath(path.relative(sourceRoot, docsDir))}.`);
  }
  if (pagesDir && pageRecords.length === 0) {
    warnings.push(`No Markdown pages found in ${normalizePath(path.relative(sourceRoot, pagesDir))}.`);
  }
  if (changelogRecords.length === 0) {
    warnings.push(
      `No Markdown changelog/blog entries found in ${normalizePath(path.relative(sourceRoot, changelogDir))}.`
    );
  }

  const sidebars = await loadDocusaurusSidebars({
    sourceRoot,
    sidebarsPath: input.sidebarsPath,
    warnings,
  });
  let selectedSidebarItems: DocusaurusSidebarItem[] | undefined;
  if (sidebars) {
    const sidebarIds = Object.keys(sidebars);
    const selectedId = input.sidebarId ?? sidebarIds[0];
    const selected = selectedId ? sidebars[selectedId] : undefined;
    if (selected) {
      selectedSidebarItems = selected;
      if (input.onlySidebarDocs) {
        docRecords = filterRecordsToSidebar({
          records: docRecords,
          items: selected,
        });
      }
    } else if (input.sidebarId) {
      warnings.push(`Sidebar id "${input.sidebarId}" was not found; meta.json order was inferred from files.`);
    }
    if (!input.sidebarId && sidebarIds.length > 1) {
      warnings.push(
        `Multiple sidebars found (${sidebarIds.join(", ")}); used "${selectedId}". Pass --sidebar-id to choose another.`
      );
    }
  }

  const docsCopied = await copyContentRecords({
    records: docRecords,
    warnings,
    dryRun: input.dryRun,
  });
  const pagesCopied = await copyContentRecords({
    records: pageRecords,
    warnings,
    dryRun: input.dryRun,
  });
  const changelogCopied = await copyContentRecords({
    records: changelogRecords,
    warnings,
    dryRun: input.dryRun,
  });
  const staticAssetsCopied = await copyDirectoryFiles({
    sourceDir: staticDir,
    targetDir: targetStaticDir,
    dryRun: input.dryRun,
  });
  const docAssetsCopied = await copyDirectoryFiles({
    sourceDir: docsDir,
    targetDir: path.join(targetStaticDir, "docs-assets"),
    filter: (file) => !MARKDOWN_EXTENSIONS.has(path.extname(file)),
    dryRun: input.dryRun,
  });

  const metaByDir = buildMetaFromRecords(docRecords);
  if (selectedSidebarItems) {
    applySidebarItemsToMeta({
      items: selectedSidebarItems,
      records: docRecords,
      metaByDir,
      warnings,
    });
  }

  const metaFilesWritten = await writeMetaFiles({
    targetDocsDir,
    metaByDir,
    dryRun: input.dryRun,
  });

  const redirects = createRedirects({
    records: [...docRecords, ...pageRecords, ...changelogRecords],
    fromOrigin: input.fromOrigin,
    toOrigin: input.toOrigin,
  });

  if (!input.dryRun) {
    await fs.mkdir(migrationDir, { recursive: true });
    await fs.writeFile(
      path.join(migrationDir, "redirects.json"),
      `${JSON.stringify(redirects, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(migrationDir, "cloudflare-redirects.txt"),
      stringifyRedirects(redirects),
      "utf8"
    );
    await fs.writeFile(
      path.join(targetRoot, "docsfn.config.migration.ts"),
      generateDocsfnConfig({ docsBasePath, changelogBasePath }),
      "utf8"
    );
  }

  const partialResult = {
    sourceRoot,
    targetRoot,
    docsCopied,
    pagesCopied,
    changelogCopied,
    staticAssetsCopied,
    docAssetsCopied,
    metaFilesWritten,
    redirectsWritten: redirects.length,
    warnings,
  };
  const reportPath = path.join(migrationDir, "report.md");
  const report = generateReport({
    result: partialResult,
    redirects,
    docsBasePath,
    pagesBasePath,
    changelogBasePath,
    oldDocsBasePath,
    oldPagesBasePath,
    oldChangelogBasePath,
  });

  if (!input.dryRun) {
    await fs.mkdir(migrationDir, { recursive: true });
    await fs.writeFile(reportPath, report, "utf8");
  }

  return {
    ...partialResult,
    reportPath,
  };
}
