#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import cac from "cac";
import chokidar from "chokidar";
import pc from "picocolors";
import {
  buildLlmsTxtArtifacts,
  buildManifest,
  buildSearchIndex,
  compileMarkdown,
  createNamedCollection,
  createDiagnostic,
  diagnosticsFromUnknownError,
  formatDiagnosticsForCli,
  hasErrorDiagnostics,
  loadDocsConfig,
  getDocsConfigDependencies,
  redactDiagnostics,
  type BuildLlmsFullTxtOptions,
  type DocsCompatPreset,
  type DocsConfig,
  type DocsDiagnostic,
  type DocsManifest,
} from "@docsfn/core";
import type { DocsProviderWatchMetadata } from "@docsfn/core";
import type { DocsSearchArtifact } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import { migrateDocusaurus } from "./migrate-docusaurus";

const cli = cac("docsfn");

interface BuildCommandOptions {
  root?: string;
  out?: string;
  outDir?: string;
  config?: string;
}

interface LlmsCommandOptions extends BuildCommandOptions {
  static?: string;
  staticDir?: string;
  embedOpenapi?: boolean;
  blog?: boolean;
}

interface DocusaurusMigrateCommandOptions {
  source?: string;
  out?: string;
  outDir?: string;
  docsDir?: string;
  pagesDir?: string;
  changelogDir?: string;
  staticDir?: string;
  sidebars?: string;
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

interface PipelineInput {
  cwd: string;
  configPath?: string;
  changedPaths?: string[];
}

interface DocsCompatReport {
  schemaVersion: 1;
  preset: DocsCompatPreset;
  transformedFiles: Array<{
    sourceId: string;
    transforms: string[];
  }>;
  unsupportedSyntax: DocsDiagnostic[];
}

interface PipelineResult {
  cwd: string;
  config?: DocsConfig;
  manifest?: DocsManifest;
  searchArtifact?: DocsSearchArtifact;
  diagnostics: DocsDiagnostic[];
  compatReport: DocsCompatReport;
  invalidatedPaths: string[];
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function stableSortDiagnostics(diagnostics: DocsDiagnostic[]): DocsDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftKey = `${left.severity}:${left.code}:${left.message}`;
    const rightKey = `${right.severity}:${right.code}:${right.message}`;
    return compareStrings(leftKey, rightKey);
  });
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveOutDirectory(input: BuildCommandOptions, cwd: string): string {
  const outValue = input.outDir ?? input.out ?? ".docsfn";
  return path.isAbsolute(outValue) ? outValue : path.resolve(cwd, outValue);
}

function createProvider(config: DocsConfig, cwd: string): FsContentProvider {
  return new FsContentProvider({
    root: cwd,
    docsDir: config.content.docsDir,
    pagesDir: config.content.pagesDir,
    blogDir: config.content.blogDir,
    apiDir: config.content.apiDir,
    assetsDir: config.content.assetsDir,
  });
}

async function loadConfig(cwd: string, configPath?: string): Promise<DocsConfig> {
  return loadDocsConfig({
    cwd,
    configPath,
  });
}

function resolveCollectionDirectories(
  config: DocsConfig,
  cwd: string
): Record<string, string[]> {
  const root = path.isAbsolute(config.content.root)
    ? path.resolve(config.content.root)
    : path.resolve(cwd, config.content.root);
  const directories = (value: string | string[] | undefined, fallback: string): string[] =>
    (Array.isArray(value) ? value : [value ?? fallback]).map((directory) =>
      path.resolve(root, directory)
    );
  const collectionDirectories: Record<string, string[]> = {
    docs: directories(config.content.docsDir, "content/docs"),
    pages: directories(config.content.pagesDir, "pages"),
    blog: directories(config.content.blogDir, "blog"),
    api: directories(config.content.apiDir, "api"),
    assets: directories(config.content.assetsDir, "public"),
  };
  for (const [collectionId, collection] of Object.entries(config.collections ?? {})) {
    collectionDirectories[createNamedCollection(collectionId)] = [
      path.resolve(root, collection.dir),
    ];
  }
  return collectionDirectories;
}

function computeInvalidatedPaths(input: {
  cwd: string;
  config?: DocsConfig;
  configPath?: string;
  changedPaths?: string[];
}): string[] {
  if (!input.changedPaths || input.changedPaths.length === 0) {
    return [];
  }

  const normalizedCwd = path.resolve(input.cwd);
  const directories = input.config
    ? resolveCollectionDirectories(input.config, normalizedCwd)
    : {};
  const configFiles = [
    path.resolve(normalizedCwd, "docsfn.config.ts"),
    path.resolve(normalizedCwd, "docsfn.config.mjs"),
    path.resolve(normalizedCwd, "docsfn.config.js"),
  ];
  if (input.configPath) {
    configFiles.push(path.resolve(normalizedCwd, input.configPath));
  }

  const invalidated = new Set<string>();

  for (const rawPath of input.changedPaths) {
    const absolutePath = path.resolve(rawPath);

    if (configFiles.includes(absolutePath)) {
      invalidated.add("config");
      continue;
    }

    let matchedCollection = false;
    for (const [collection, collectionDirectories] of Object.entries(directories)) {
      for (const directory of collectionDirectories) {
        const absoluteDirectory = path.resolve(directory);
        if (
          absolutePath === absoluteDirectory ||
          absolutePath.startsWith(`${absoluteDirectory}${path.sep}`)
        ) {
          const relative = normalizePath(path.relative(absoluteDirectory, absolutePath));
          invalidated.add(`${collection}:${relative || "*"}`);
          matchedCollection = true;
          break;
        }
      }
      if (matchedCollection) {
        break;
      }
    }

    if (!matchedCollection) {
      const relativeToRoot = path.relative(normalizedCwd, absolutePath);
      if (!relativeToRoot.startsWith("..")) {
        invalidated.add(`path:${normalizePath(relativeToRoot)}`);
      } else {
        invalidated.add(`path:${normalizePath(absolutePath)}`);
      }
    }
  }

  return [...invalidated].sort(compareStrings);
}

function createCompatReport(input: {
  preset: DocsCompatPreset;
  diagnostics: DocsDiagnostic[];
  transformedFiles?: Array<{ sourceId: string; transforms: string[] }>;
}): DocsCompatReport {
  return {
    schemaVersion: 1,
    preset: input.preset,
    transformedFiles: input.transformedFiles ?? [],
    unsupportedSyntax: input.diagnostics.filter(
      (diagnostic) => diagnostic.code === "DOCS_COMPAT_UNSUPPORTED"
    ),
  };
}

function compileManifestSources(
  manifest: DocsManifest,
  preset: DocsCompatPreset,
  diagnostics: DocsDiagnostic[]
): Array<{ sourceId: string; transforms: string[] }> {
  const transformedFiles: Array<{ sourceId: string; transforms: string[] }> = [];
  const entries = [
    ...Object.values(manifest.pages).map((page) => ({
      sourceId: page.id,
      source: page.body,
      sourcePath: page.id,
    })),
    ...Object.values(manifest.posts).map((post) => ({
      sourceId: post.id,
      source: post.body,
      sourcePath: post.id,
    })),
  ];

  for (const entry of entries) {
    try {
      // buildManifest has already applied the provider source trust policy, including path allowlists.
      const compiled = compileMarkdown({
        allowRawHtml: true,
        source: entry.source,
        sourcePath: entry.sourcePath,
        compatPreset: preset,
      });
      if (compiled.transformedSource !== entry.source) {
        transformedFiles.push({
          sourceId: entry.sourceId,
          transforms: [preset],
        });
      }
      diagnostics.push(...compiled.diagnostics);
    } catch (error) {
      diagnostics.push(
        ...diagnosticsFromUnknownError(error, {
          code: "DOCS_MDX_COMPILE_FAILED",
          message: `failed to compile ${entry.sourceId}`,
        })
      );
    }
  }

  return transformedFiles;
}

async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const diagnostics: DocsDiagnostic[] = [];
  let config: DocsConfig | undefined;
  let manifest: DocsManifest | undefined;
  let searchArtifact: DocsSearchArtifact | undefined;
  let transformedFiles: Array<{ sourceId: string; transforms: string[] }> = [];

  try {
    config = await loadConfig(input.cwd, input.configPath);
  } catch (error) {
    diagnostics.push(
      ...diagnosticsFromUnknownError(error, {
        code: "DOCS_CONFIG_INVALID",
        message: "failed to load docsfn config",
      })
    );
  }

  if (config) {
    const provider = createProvider(config, input.cwd);

    try {
      manifest = await buildManifest(provider, config);
    } catch (error) {
      diagnostics.push(
        ...diagnosticsFromUnknownError(error, {
          code: "DOCS_ARTIFACT_INVALID",
          message: "failed to build docs manifest",
        })
      );
    }

    if (manifest) {
      const preset = config.compat?.preset ?? "none";
      transformedFiles = compileManifestSources(manifest, preset, diagnostics);
      try {
        searchArtifact = await buildSearchIndex(manifest, {
          search: config.search,
          auth: config.auth,
        });
      } catch (error) {
        diagnostics.push(
          ...diagnosticsFromUnknownError(error, {
            code: "DOCS_SEARCH_BUILD_FAILED",
            message: "search artifact build failed",
          })
        );
      }
    }
  }

  const invalidatedPaths = computeInvalidatedPaths({
    cwd: input.cwd,
    config,
    configPath: input.configPath,
    changedPaths: input.changedPaths,
  });

  if (invalidatedPaths.length > 0) {
    diagnostics.push(
      createDiagnostic({
        code: "DOCS_ARTIFACT_INVALID",
        severity: "info",
        message: `dev rebuild invalidated ${invalidatedPaths.length} path(s)`,
        details: {
          invalidatedPaths,
        },
      })
    );
  }

  const finalizedDiagnostics = stableSortDiagnostics(redactDiagnostics(diagnostics));
  const preset = config?.compat?.preset ?? "none";

  return {
    cwd: input.cwd,
    config,
    manifest: hasErrorDiagnostics(finalizedDiagnostics) ? undefined : manifest,
    searchArtifact: hasErrorDiagnostics(finalizedDiagnostics) ? undefined : searchArtifact,
    diagnostics: finalizedDiagnostics,
    compatReport: createCompatReport({
      preset,
      diagnostics: finalizedDiagnostics,
      transformedFiles,
    }),
    invalidatedPaths,
  };
}

async function writeArtifacts(outDir: string, result: PipelineResult): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });

  await fs.writeFile(
    path.join(outDir, "diagnostics.json"),
    JSON.stringify(result.diagnostics, null, 2)
  );

  await fs.writeFile(
    path.join(outDir, "compat-report.json"),
    JSON.stringify(result.compatReport, null, 2)
  );

  if (result.manifest) {
    await fs.writeFile(
      path.join(outDir, "manifest.json"),
      JSON.stringify(result.manifest, null, 2)
    );
  } else {
    await fs.rm(path.join(outDir, "manifest.json"), { force: true });
  }

  const searchEnabled = result.config?.search?.enabled ?? true;
  if (searchEnabled && result.searchArtifact) {
    await fs.writeFile(
      path.join(outDir, "search.json"),
      JSON.stringify(result.searchArtifact)
    );
  } else {
    await fs.rm(path.join(outDir, "search.json"), { force: true });
  }
}

function printDiagnostics(diagnostics: DocsDiagnostic[]): void {
  if (diagnostics.length === 0) {
    console.log(pc.green("✔ No diagnostics reported"));
    return;
  }

  const lines = formatDiagnosticsForCli(diagnostics);
  for (let index = 0; index < diagnostics.length; index += 1) {
    const diagnostic = diagnostics[index];
    const line = lines[index] ?? "";
    const colorize =
      diagnostic.severity === "error"
        ? pc.red
        : diagnostic.severity === "warning"
          ? pc.yellow
          : pc.cyan;
    console.log(colorize(line));
  }
}

function printCommandSummary(command: string, result: PipelineResult): void {
  const total = result.diagnostics.length;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;

  console.log(
    pc.blue(
      `ℹ ${command}: ${total} diagnostic(s) (${errors} errors, ${warnings} warnings)`
    )
  );

  if (result.invalidatedPaths.length > 0) {
    console.log(
      pc.dim(
        JSON.stringify(
          {
            event: "docsfn.dev.invalidate",
            invalidated: result.invalidatedPaths,
          },
          null,
          2
        )
      )
    );
  }
}

function resolveWatchTargets(input: {
  cwd: string;
  config?: DocsConfig;
  configPath?: string;
  providerMetadata?: DocsProviderWatchMetadata;
  outDir: string;
}): string[] {
  const targets = new Set<string>();
  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(input.outDir);

  for (const candidate of resolveConfigWatchPaths(cwd, input.configPath)) {
    targets.add(candidate);
  }

  if (input.providerMetadata?.watchedDirectories?.length) {
    for (const directory of input.providerMetadata.watchedDirectories) {
      const resolved = path.resolve(directory);
      if (resolved === outDir || resolved.startsWith(`${outDir}${path.sep}`)) {
        continue;
      }
      targets.add(resolved);
    }
  } else if (input.config) {
    const directories = resolveCollectionDirectories(input.config, cwd);
    for (const directory of Object.values(directories).flat()) {
      const resolved = path.resolve(directory);
      if (resolved === outDir || resolved.startsWith(`${outDir}${path.sep}`)) {
        continue;
      }
      targets.add(resolved);
    }
  }

  return [...targets].sort(compareStrings);
}

function resolveConfigWatchPaths(cwd: string, configPath?: string): string[] {
  const paths = [
    path.resolve(cwd, "docsfn.config.ts"),
    path.resolve(cwd, "docsfn.config.mjs"),
    path.resolve(cwd, "docsfn.config.js"),
  ];
  if (configPath) {
    paths.push(path.resolve(cwd, configPath));
  }
  return [...new Set([...paths, ...paths.flatMap(getDocsConfigDependencies)])];
}

function isConfigWatchPath(changedPath: string, cwd: string, configPath?: string): boolean {
  const absolutePath = path.resolve(changedPath);
  return resolveConfigWatchPaths(cwd, configPath).includes(absolutePath);
}

async function resolveProviderWatchMetadata(
  config: DocsConfig,
  cwd: string
): Promise<DocsProviderWatchMetadata | undefined> {
  const provider = createProvider(config, cwd);
  if (typeof provider.watch !== "function") return undefined;

  try {
    const subscription = await provider.watch({
      config,
      onChange: () => undefined,
    });
    const metadata = subscription.metadata;
    await subscription.close();
    return metadata;
  } catch {
    return undefined;
  }
}

async function runValidateCommand(
  rootArg: string | undefined,
  options: BuildCommandOptions
): Promise<void> {
  const rootValue = options.root ?? rootArg ?? ".";
  const cwd = path.resolve(rootValue);

  const result = await runPipeline({
    cwd,
    configPath: options.config,
  });

  printDiagnostics(result.diagnostics);
  printCommandSummary("validate", result);

  process.exitCode = hasErrorDiagnostics(result.diagnostics) ? 1 : 0;
}

async function runBuildCommand(
  rootArg: string | undefined,
  options: BuildCommandOptions
): Promise<void> {
  const rootValue = options.root ?? rootArg ?? ".";
  const cwd = path.resolve(rootValue);
  const outDir = resolveOutDirectory(options, cwd);

  console.log(pc.blue("ℹ Building docs..."));
  const start = Date.now();

  const result = await runPipeline({
    cwd,
    configPath: options.config,
  });
  await writeArtifacts(outDir, result);

  printDiagnostics(result.diagnostics);
  printCommandSummary("build", result);

  if (!hasErrorDiagnostics(result.diagnostics) && result.searchArtifact) {
    console.log(
      pc.green(
        `✔ Built in ${Date.now() - start}ms (${result.searchArtifact.bytes} bytes search artifact)`
      )
    );
  }

  process.exitCode = hasErrorDiagnostics(result.diagnostics) ? 1 : 0;
}

async function runDevCommand(
  rootArg: string | undefined,
  options: BuildCommandOptions
): Promise<void> {
  const rootValue = options.root ?? rootArg ?? ".";
  const cwd = path.resolve(rootValue);
  const outDir = resolveOutDirectory(options, cwd);

  console.log(pc.blue("ℹ Starting docsfn dev..."));

  const initialResult = await runPipeline({
    cwd,
    configPath: options.config,
  });
  await writeArtifacts(outDir, initialResult);

  printDiagnostics(initialResult.diagnostics);
  printCommandSummary("dev:initial", initialResult);

  if (hasErrorDiagnostics(initialResult.diagnostics) || !initialResult.config) {
    process.exitCode = 1;
  }

  const providerMetadata = initialResult.config
    ? await resolveProviderWatchMetadata(initialResult.config, cwd)
    : undefined;

  const watchTargets = resolveWatchTargets({
    cwd,
    config: initialResult.config,
    configPath: options.config,
    providerMetadata,
    outDir,
  });

  console.log(pc.cyan(`ℹ Watching for changes in ${watchTargets.length} location(s)...`));

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    ignored: (pathname) => /^\.docsfn\..+\.(?:mjs|cjs)$/.test(path.basename(pathname)),
  });
  let activeWatchTargets = new Set(watchTargets);

  async function refreshWatchTargets(config: DocsConfig): Promise<void> {
    const metadata = await resolveProviderWatchMetadata(config, cwd);
    const nextTargets = new Set(
      resolveWatchTargets({
        cwd,
        config,
        configPath: options.config,
        providerMetadata: metadata,
        outDir,
      })
    );
    const removed = [...activeWatchTargets].filter((target) => !nextTargets.has(target));
    const added = [...nextTargets].filter((target) => !activeWatchTargets.has(target));
    if (removed.length > 0) await watcher.unwatch(removed);
    if (added.length > 0) watcher.add(added);
    activeWatchTargets = nextTargets;
  }

  let rebuildQueue = Promise.resolve();

  watcher.on("all", (_event, changedPath) => {
    const absolutePath = path.resolve(changedPath);
    if (absolutePath === outDir || absolutePath.startsWith(`${outDir}${path.sep}`)) {
      return;
    }
    console.log(pc.dim(`Change detected: ${absolutePath}`));

    rebuildQueue = rebuildQueue
      .then(async () => {
        const result = await runPipeline({
          cwd,
          configPath: options.config,
          changedPaths: [absolutePath],
        });
        await writeArtifacts(outDir, result);
        printDiagnostics(result.diagnostics);
        printCommandSummary("dev:rebuild", result);
        if (hasErrorDiagnostics(result.diagnostics) || !result.config) {
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
        if (result.config && isConfigWatchPath(absolutePath, cwd, options.config)) {
          await refreshWatchTargets(result.config);
        }
      })
      .catch((error) => {
        console.error(
          pc.red(
            error instanceof Error
              ? `dev rebuild failed: ${error.message}`
              : "dev rebuild failed"
          )
        );
      });
  });
}

async function runLlmsCommand(
  rootArg: string | undefined,
  options: LlmsCommandOptions
): Promise<void> {
  const rootValue = options.root ?? rootArg ?? ".";
  const cwd = path.resolve(rootValue);
  const staticDirValue = options.staticDir ?? options.static ?? "static";
  const staticDir = path.isAbsolute(staticDirValue)
    ? staticDirValue
    : path.resolve(cwd, staticDirValue);

  console.log(pc.blue("ℹ Generating llms.txt artifacts..."));
  const start = Date.now();

  const result = await runPipeline({
    cwd,
    configPath: options.config,
  });

  printDiagnostics(result.diagnostics);
  printCommandSummary("llms", result);

  if (hasErrorDiagnostics(result.diagnostics)) {
    process.exitCode = 1;
    return;
  }

  if (!result.manifest) {
    process.exitCode = 1;
    return;
  }

  const llmsOptions: BuildLlmsFullTxtOptions = {
    canonicalUrl: result.config?.site?.canonicalUrl,
    embedOpenApiSpec: options.embedOpenapi === true,
    includeBlog: options.blog !== false,
    auth: result.config?.auth,
  };

  const artifacts = buildLlmsTxtArtifacts(result.manifest, llmsOptions);
  await fs.mkdir(staticDir, { recursive: true });
  await fs.writeFile(path.join(staticDir, "llms.txt"), artifacts.llmsTxt, "utf8");
  await fs.writeFile(path.join(staticDir, "llms-full.txt"), artifacts.llmsFullTxt, "utf8");

  const llmsTxtBytes = Buffer.byteLength(artifacts.llmsTxt, "utf8");
  const llmsFullTxtBytes = Buffer.byteLength(artifacts.llmsFullTxt, "utf8");

  console.log(
    pc.green(
      `✔ Wrote ${path.relative(cwd, path.join(staticDir, "llms.txt"))} (${llmsTxtBytes} bytes)`
    )
  );
  console.log(
    pc.green(
      `✔ Wrote ${path.relative(cwd, path.join(staticDir, "llms-full.txt"))} (${llmsFullTxtBytes} bytes)`
    )
  );
  console.log(pc.dim(`Generated in ${Date.now() - start}ms`));
}

async function runDocusaurusMigrateCommand(
  sourceArg: string | undefined,
  options: DocusaurusMigrateCommandOptions
): Promise<void> {
  const source = path.resolve(options.source ?? sourceArg ?? ".");
  const targetValue = options.outDir ?? options.out ?? "docsfn-migration";
  const target = path.isAbsolute(targetValue) ? targetValue : path.resolve(process.cwd(), targetValue);

  console.log(pc.blue("ℹ Migrating Docusaurus content to docsfn..."));
  const start = Date.now();

  const result = await migrateDocusaurus({
    source,
    target,
    docsDir: options.docsDir,
    pagesDir: options.pagesDir,
    changelogDir: options.changelogDir,
    staticDir: options.staticDir,
    sidebarsPath: options.sidebars,
    sidebarId: options.sidebarId,
    docsBasePath: options.docsBasePath,
    pagesBasePath: options.pagesBasePath,
    changelogBasePath: options.changelogBasePath,
    oldDocsBasePath: options.oldDocsBasePath,
    oldPagesBasePath: options.oldPagesBasePath,
    oldChangelogBasePath: options.oldChangelogBasePath,
    fromOrigin: options.fromOrigin,
    toOrigin: options.toOrigin,
    onlySidebarDocs: options.onlySidebarDocs === true,
    dryRun: options.dryRun === true,
  });

  console.log(pc.green(`✔ Docs copied: ${result.docsCopied}`));
  console.log(pc.green(`✔ Pages copied: ${result.pagesCopied}`));
  console.log(pc.green(`✔ Changelog entries copied: ${result.changelogCopied}`));
  console.log(pc.green(`✔ Static assets copied: ${result.staticAssetsCopied}`));
  console.log(pc.green(`✔ Docs-local assets copied: ${result.docAssetsCopied}`));
  console.log(pc.green(`✔ meta.json files written: ${result.metaFilesWritten}`));
  console.log(pc.green(`✔ Redirects prepared: ${result.redirectsWritten}`));

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(pc.yellow(`⚠ ${warning}`));
    }
  }

  if (options.dryRun) {
    console.log(pc.dim("Dry run only; no files were written."));
  } else {
    console.log(pc.cyan(`ℹ Report: ${path.relative(process.cwd(), result.reportPath)}`));
  }

  console.log(pc.dim(`Migrated in ${Date.now() - start}ms`));
}

async function runMigrateCommand(
  kind: string | undefined,
  sourceArg: string | undefined,
  options: DocusaurusMigrateCommandOptions
): Promise<void> {
  if (kind !== "docusaurus") {
    console.error(pc.red(`Unknown migration kind: ${kind ?? "(missing)"}`));
    console.error(pc.dim("Supported migration kinds: docusaurus"));
    process.exitCode = 1;
    return;
  }

  await runDocusaurusMigrateCommand(sourceArg, options);
}

cli
  .command("validate [root]", "Validate docs configuration and content")
  .option("--root <dir>", "Root directory")
  .option("--config <path>", "Explicit docsfn config path")
  .action(async (root, options) => {
    await runValidateCommand(root, options as BuildCommandOptions);
  });

cli
  .command("build [root]", "Build the documentation")
  .option("--root <dir>", "Root directory")
  .option("--config <path>", "Explicit docsfn config path")
  .option("--out <dir>", "Output directory (legacy option)")
  .option("--out-dir <dir>", "Output directory")
  .action(async (root, options) => {
    await runBuildCommand(root, options as BuildCommandOptions);
  });

cli
  .command("dev [root]", "Start dev mode")
  .option("--root <dir>", "Root directory")
  .option("--config <path>", "Explicit docsfn config path")
  .option("--out <dir>", "Output directory (legacy option)")
  .option("--out-dir <dir>", "Output directory")
  .action(async (root, options) => {
    await runDevCommand(root, options as BuildCommandOptions);
  });

cli
  .command("llms [root]", "Generate llms.txt and llms-full.txt for AI assistants")
  .option("--root <dir>", "Root directory")
  .option("--config <path>", "Explicit docsfn config path")
  .option("--static <dir>", "Output directory for static assets (legacy)")
  .option("--static-dir <dir>", "Output directory for static assets")
  .option("--embed-openapi", "Embed full OpenAPI JSON in llms-full.txt")
  .option("--no-blog", "Exclude blog posts from generated artifacts")
  .action(async (root, options) => {
    await runLlmsCommand(root, options as LlmsCommandOptions);
  });

cli
  .command("migrate <kind> [source]", "Migrate an existing docs site into docsfn content")
  .option("--source <dir>", "Docusaurus site root")
  .option("--out <dir>", "Target output directory (legacy option)")
  .option("--out-dir <dir>", "Target output directory")
  .option("--docs-dir <dir>", "Docusaurus docs directory", { default: "docs" })
  .option("--pages-dir <dir>", "Docusaurus product pages directory, e.g. src/pages/memotron")
  .option("--changelog-dir <dir>", "Docusaurus changelog/blog directory", { default: "blog" })
  .option("--static-dir <dir>", "Docusaurus static assets directory", { default: "static" })
  .option("--sidebars <path>", "Explicit Docusaurus sidebars.js/ts path")
  .option("--sidebar-id <id>", "Sidebar id to convert when multiple sidebars exist")
  .option("--docs-base-path <path>", "New docs route base", { default: "/docs" })
  .option("--pages-base-path <path>", "New pages route base, defaults to docs route base")
  .option("--changelog-base-path <path>", "New changelog route base", { default: "/changelog" })
  .option("--old-docs-base-path <path>", "Old Docusaurus docs route base", { default: "/" })
  .option("--old-pages-base-path <path>", "Old Docusaurus product pages route base")
  .option("--old-changelog-base-path <path>", "Old Docusaurus changelog/blog route base", { default: "/changelog" })
  .option("--from-origin <url>", "Old docs origin, e.g. https://docs.memotron.app")
  .option("--to-origin <url>", "New product origin, e.g. https://memotron.app")
  .option("--only-sidebar-docs", "Copy only docs referenced by the selected Docusaurus sidebar")
  .option("--dry-run", "Print summary without writing files")
  .action(async (kind, source, options) => {
    await runMigrateCommand(kind, source, options as DocusaurusMigrateCommandOptions);
  });

cli.help();
cli.parse();
