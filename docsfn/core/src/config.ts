import { createHash, randomUUID } from "node:crypto";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createDiagnostic,
  createDocsError,
  type DocsError,
} from "./diagnostics";
import { normalizeDatedCollectionId } from "./provider";
import type { DocsConfig } from "./types";

export interface LoadDocsConfigInput {
  cwd: string;
  configPath?: string;
}

export const DEFAULT_CONFIG_FILENAMES = [
  "docsfn.config.ts",
  "docsfn.config.mjs",
  "docsfn.config.js",
] as const;

const docsVersionConfigSchema = z.object({
  slug: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "version slug must be a single safe path segment",
    ),
  label: z.string().min(1, "versions.versions[].label is required"),
  default: z.boolean().optional(),
});

const docsVersionsSchema = z
  .object({
    mode: z.enum(["none", "path-prefix", "path-segment"]),
    versions: z
      .array(docsVersionConfigSchema)
      .min(1, "versions.versions must contain at least one version"),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.versions.map((version) => version.slug)).size !==
      value.versions.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions"],
        message: "version slugs must be unique",
      });
    }
    const defaultCount = value.versions.filter(
      (version) => version.default,
    ).length;
    if (defaultCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions"],
        message: "versions.versions must mark at most one default version",
      });
    }
  });

const docsTopNavItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    label: z.string().min(1, "navigation.topNav[].label is required"),
    href: z.string().min(1, "navigation.topNav[].href is required"),
    external: z.boolean().optional(),
    children: z.array(docsTopNavItemSchema).optional(),
  })
);

function isLocalRoute(value: string): boolean {
  return /^\/(?!\/)[^?#\\\u0000-\u0020]*$/.test(value);
}

const absoluteRouteSchema = (pathLabel: string) =>
  z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || isLocalRoute(value),
      `${pathLabel} must start with '/'`
    );

const datedCollectionConfigSchema = z.object({
  type: z.literal("dated").optional(),
  dir: z.string().min(1, "collections.*.dir is required"),
  routeBase: z
    .string()
    .min(1, "collections.*.routeBase is required")
    .refine((value) => isLocalRoute(value), "collections.*.routeBase must start with '/'"),
  feedPath: absoluteRouteSchema("collections.*.feedPath"),
  label: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

const docsConfigSchema = z.object({
  schemaVersion: z.literal(1, {
    errorMap: () => ({ message: "schemaVersion must be 1" }),
  }),
  site: z.object({
    title: z.string().min(1, "site.title is required"),
    description: z.string().optional(),
    basePath: z
      .string()
      .optional()
      .refine((value) => value === undefined || isLocalRoute(value), "site.basePath must start with '/'"),
    canonicalUrl: z.string().url("site.canonicalUrl must be a valid URL").optional(),
    defaultLocale: z.string().min(1).optional(),
    showFooter: z.boolean().optional(),
    theme: z.record(z.unknown()).optional(),
    editLink: z.record(z.unknown()).optional(),
    pageActions: z.array(z.record(z.unknown())).optional(),
  }),
  compat: z
    .object({
      preset: z.enum(["none", "fumadocs-v15"], {
        errorMap: () => ({
          message: "compat.preset must be one of none or fumadocs-v15",
        }),
      }),
      allowRawHtml: z.literal(false).optional(),
    })
    .optional(),
  versions: docsVersionsSchema.optional(),
  content: z.object({
    root: z.string().min(1, "content.root is required"),
    docsDir: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .optional(),
    pagesDir: z.string().min(1).optional(),
    blogDir: z.string().min(1).optional(),
    apiDir: z.string().min(1).optional(),
    assetsDir: z.string().min(1).optional(),
    metaFileName: z.string().min(1).optional(),
  }),
  navigation: z
    .object({
      topNav: z.array(docsTopNavItemSchema).optional(),
      sidebars: z
        .record(
          z.object({
            title: z.string().optional(),
            root: z.boolean().optional(),
            include: z.array(z.string()).optional(),
          })
        )
        .optional(),
    })
    .optional(),
  blog: z
    .object({
      routeBase: absoluteRouteSchema("blog.routeBase"),
      feedPath: absoluteRouteSchema("blog.feedPath"),
    })
    .optional(),
  collections: z.record(datedCollectionConfigSchema).optional(),
  search: z
    .object({
      enabled: z.boolean(),
      scopes: z.array(z.string().min(1)),
      bodyIndexing: z.enum(["full", "summary", "disabled"]).optional(),
      maxArtifactBytes: z.number().int().positive().optional(),
      routeScopeOverrides: z
        .array(
          z.object({
            pattern: z.string().min(1, "search.routeScopeOverrides[].pattern is required"),
            scope: z.string().min(1, "search.routeScopeOverrides[].scope is required"),
          })
        )
        .optional(),
    })
    .optional(),
  auth: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(["public", "private", "mixed"]),
    })
    .optional(),
  analytics: z
    .object({
      enabled: z.boolean(),
      provider: z.literal("watchfn"),
      respectDnt: z.boolean(),
    })
    .optional(),
}).superRefine((value, context) => {
  const seenNormalizedIds = new Map<string, string>();
  for (const collectionId of Object.keys(value.collections ?? {})) {
    const normalizedId = normalizeDatedCollectionId(collectionId);
    if (!normalizedId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collections", collectionId],
        message: "collection id must normalize to a nonempty identifier",
      });
      continue;
    }
    if (normalizedId === "blog") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collections", collectionId],
        message: "collection id is reserved for the legacy blog surface",
      });
    }
    const previousId = seenNormalizedIds.get(normalizedId);
    if (previousId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collections", collectionId],
        message: `collection id collides with '${previousId}' after normalization`,
      });
      continue;
    }
    seenNormalizedIds.set(normalizedId, collectionId);
  }
});

export function createDefaultDocsConfig(input: { cwd: string }): DocsConfig {
  return {
    schemaVersion: 1,
    site: {
      title: "Docs",
      basePath: "/docs",
    },
    compat: {
      preset: "none",
    },
    content: {
      root: input.cwd,
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
    },
    search: {
      enabled: true,
      scopes: ["docs"],
      bodyIndexing: "summary",
    },
    auth: {
      enabled: false,
      mode: "public",
    },
    analytics: {
      enabled: false,
      provider: "watchfn",
      respectDnt: true,
    },
  };
}

export async function loadDocsConfig(input: LoadDocsConfigInput): Promise<DocsConfig> {
  const cwd = resolve(input.cwd);
  const discoveredConfigPath = await discoverConfigPath({
    cwd,
    configPath: input.configPath,
  });

  if (!discoveredConfigPath) {
    return createDefaultDocsConfig({ cwd });
  }

  const loadedConfig = await loadConfigModule(discoveredConfigPath);
  return validateDocsConfig(loadedConfig, discoveredConfigPath);
}

async function discoverConfigPath(input: {
  cwd: string;
  configPath?: string;
}): Promise<string | null> {
  if (input.configPath) {
    const explicitPath = isAbsolute(input.configPath)
      ? input.configPath
      : resolve(input.cwd, input.configPath);

    if (!(await fileExists(explicitPath))) {
      throw createDocsError({
        code: "DOCS_CONFIG_INVALID",
        message: `docsfn config file does not exist at ${explicitPath}`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_CONFIG_INVALID",
            message: `docsfn config file does not exist at ${explicitPath}`,
            location: { absolutePath: explicitPath },
          }),
        ],
      });
    }

    return explicitPath;
  }

  for (const fileName of DEFAULT_CONFIG_FILENAMES) {
    const candidate = resolve(input.cwd, fileName);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const pendingConfigLoads = new Map<string, Promise<unknown>>();

async function loadConfigModule(configPath: string): Promise<unknown> {
  try {
    const key = resolve(configPath);
    let pending = pendingConfigLoads.get(key);
    if (!pending) {
      pending = loadFreshConfigGraph(key).finally(() => pendingConfigLoads.delete(key));
      pendingConfigLoads.set(key, pending);
    }
    return await pending;
  } catch (error) {
    throw createDocsError({
      code: "DOCS_CONFIG_INVALID",
      message: `failed to load docsfn config at ${configPath}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_CONFIG_INVALID",
          message: `failed to load docsfn config at ${configPath}`,
          location: { absolutePath: configPath },
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      ],
      cause: error,
    });
  }
}

const configDependencyPaths = new Map<string, string[]>();

export function getDocsConfigDependencies(configPath: string): string[] {
  return configDependencyPaths.get(resolve(configPath)) ?? [];
}

async function isCommonJsScope(file: string): Promise<boolean> {
  let directory = dirname(file);
  while (true) {
    const manifest = join(directory, "package.json");
    if (await fileExists(manifest)) return JSON.parse(await readFile(manifest, "utf8")).type !== "module";
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

async function loadFreshConfigGraph(configPath: string): Promise<unknown> {
  const typescriptModuleName =
    process.env.DOCSFN_TYPESCRIPT_MODULE ?? "typescript";
  const ts: typeof import("typescript") = await import(typescriptModuleName);
  const modules = new Map<
    string,
    {
      source: string;
      commonjs: boolean;
      json: boolean;
      imports: Array<{
        start: number;
        end: number;
        target: string;
        require: boolean;
        stripEnd?: number;
      }>;
    }
  >();
  const unresolvedDependencies = new Set<string>();
  let totalBytes = 0;
  async function visit(file: string): Promise<void> {
    if (modules.has(file)) return;
    if (modules.size >= 256)
      throw new Error("configuration import graph exceeds 256 modules");
    if ((await stat(file)).size > 4 * 1024 * 1024 - totalBytes)
      throw new Error("configuration import graph exceeds 4 MiB");
    const raw = await readFile(file, "utf8");
    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > 4 * 1024 * 1024)
      throw new Error("configuration import graph exceeds 4 MiB");
    const isJson = extname(file) === ".json";
    const source = isJson
      ? raw
      : ts.transpileModule(raw, {
          fileName: file,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText;
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    const commonjs =
      extname(file) === ".cjs" ||
      (!ts.isExternalModule(ast) && (["", ".js"].includes(extname(file))
        ? await isCommonJsScope(file)
        : /\b(?:module\.exports|exports\.)/.test(source)));
    const record = {
      source,
      commonjs,
      json: isJson,
      imports: [] as Array<{
        start: number;
        end: number;
        target: string;
        require: boolean;
        stripEnd?: number;
      }>,
    };
    modules.set(file, record);
    if (isJson) {
      JSON.parse(source);
      return;
    }
    const literals: Array<{
      literal: import("typescript").StringLiteralLike;
      require: boolean;
    }> = [];
    function collect(node: import("typescript").Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        literals.push({ literal: node.moduleSpecifier, require: false });
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        literals.push({ literal: node.arguments[0], require: false });
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        literals.push({ literal: node.arguments[0], require: true });
      ts.forEachChild(node, collect);
    }
    collect(ast);
    for (const { literal, require: isRequire } of literals) {
      if (!literal.text.startsWith(".")) continue;
      let target = resolve(dirname(file), literal.text);
      if (!extname(target)) {
        const extensions = [".ts", ".js", ".mjs", ".cjs", ".json"];
        const candidates = [target, ...extensions.map(extension => target + extension), ...extensions.map(extension => join(target, `index${extension}`))];
        let found: string | undefined;
        for (const candidate of candidates) {
          if (await stat(candidate).then(info => info.isFile(), () => false)) { found = candidate; break; }
        }
        if (!found) {
          for (const candidate of candidates) unresolvedDependencies.add(candidate);
          throw new Error("configuration dependency does not exist");
        }
        target = found;
      }
      if (!["", ".js", ".mjs", ".ts", ".cjs", ".json"].includes(extname(target)))
        continue;
      let stripEnd: number | undefined;
      if (extname(target) === ".json" && !isRequire) {
        // JSON dependencies become CommonJS wrappers, so neither static nor
        // dynamic imports need runtime-specific JSON import attributes.
        const parent = literal.parent;
        if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.attributes) stripEnd = parent.attributes.end;
        if (ts.isCallExpression(parent) && parent.arguments.length > 1) stripEnd = parent.arguments[parent.arguments.length - 1].end;
      }
      // Record before reading so a missing dependency can be watched and repaired.
      record.imports.push({
        start: literal.getStart(ast),
        end: literal.end,
        target,
        require: isRequire,
        stripEnd,
      });
      await visit(target);
    }
  }
  configPath = resolve(configPath);
  try {
    await visit(configPath);
  } finally {
    configDependencyPaths.set(configPath, [
      ...new Set([
        ...modules.keys(),
        ...unresolvedDependencies,
        ...[...modules.values()].flatMap((module) =>
          module.imports.map((entry) => entry.target),
        ),
      ]),
    ]);
  }
  const fingerprint = createHash("sha256");
  for (const [file, module] of [...modules].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    fingerprint.update(file).update(module.source);
  const version = fingerprint.digest("hex").slice(0, 24);
  const loadNonce = randomUUID();
  const outputPaths = new Map(
    [...modules.keys()].map((file) => [
      file,
      join(
        dirname(file),
        `.docsfn.${version}.${loadNonce}.${createHash("sha256").update(file).digest("hex").slice(0, 16)}.${modules.get(file)!.json || modules.get(file)!.commonjs ? "cjs" : "mjs"}`,
      ),
    ]),
  );
  const written: string[] = [];
  try {
    for (const [file, module] of modules) {
      let source = module.json ? `module.exports = JSON.parse(${JSON.stringify(module.source)});\n` : module.source;
      for (const entry of [...module.imports].sort(
        (a, b) => b.start - a.start,
      )) {
        source =
          source.slice(0, entry.start) +
          JSON.stringify(
            entry.require
              ? outputPaths.get(entry.target)!
              : pathToFileURL(outputPaths.get(entry.target)!).href,
          ) +
          source.slice(entry.stripEnd ?? entry.end);
      }
      const output = outputPaths.get(file)!;
      await writeFile(output, source, { encoding: "utf8", mode: 0o600 });
      written.push(output);
    }
    return resolveConfigExport(
      await import(pathToFileURL(outputPaths.get(configPath)!).href),
    );
  } finally {
    for (const file of written) await unlink(file).catch(() => undefined);
  }
}

function resolveConfigExport(moduleValue: unknown): unknown {
  const candidate =
    typeof moduleValue === "object" &&
    moduleValue !== null &&
    "default" in moduleValue
      ? (moduleValue as { default: unknown }).default
      : moduleValue;

  return typeof candidate === "function" ? (candidate as () => unknown)() : candidate;
}

function validateDocsConfig(loadedConfig: unknown, configPath: string): DocsConfig {
  const parsed = docsConfigSchema.safeParse(loadedConfig);
  if (parsed.success) {
    return parsed.data as DocsConfig;
  }

  const message = formatConfigValidationMessage(parsed.error.issues);
  const diagnostics = [
    createDiagnostic({
      code: "DOCS_CONFIG_INVALID",
      message,
      location: {
        absolutePath: configPath,
      },
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    }),
  ];

  throw createDocsError({
    code: "DOCS_CONFIG_INVALID",
    message,
    diagnostics,
  });
}

function formatConfigValidationMessage(
  issues: Array<{ path: Array<string | number>; message: string }>
): string {
  const mappedMessages = issues.map((issue) => {
    const path = issue.path.map(String).join(".");

    if (path === "schemaVersion") {
      return "schemaVersion must be 1";
    }

    if (path === "site.basePath") {
      return "site.basePath must start with '/'";
    }

    if (path === "compat.preset") {
      return "compat.preset must be one of none or fumadocs-v15";
    }

    return path ? `${path} ${issue.message}` : issue.message;
  });

  return Array.from(new Set(mappedMessages)).join(" and ");
}

export function isDocsConfigError(value: unknown): value is DocsError {
  return (
    value instanceof Error &&
    "name" in value &&
    value.name === "DocsError" &&
    "code" in value
  );
}
