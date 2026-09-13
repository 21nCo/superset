import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRegistry, type BuiltRegistry } from './build-registry';
import {
  checksumContent,
  checksumFile,
  readLockFile,
  selectedFromLock,
  serializeLockFile,
  serializeSelectedComponents,
  type UifnLockFile,
  type UifnLockFileEntry,
} from './lockfile';
import { REQUIRED_FRAMEWORKS, type RegistryDependency, type RegistryFramework, type RegistryManifest } from './schema';
import { assertContainedPath, type TransactionChange } from './transaction';

export interface RegistryPlanFile {
  path: string;
  operation: 'create' | 'update' | 'unchanged';
  previousSha256?: string;
  nextSha256: string;
  sourceSha256?: string;
}

export interface RegistryPlanDependency extends RegistryDependency {
  operation: 'add' | 'present';
  resolvedVersion: string;
}

export interface RegistryInstallPlan {
  schemaVersion: 1;
  rootDir: string;
  framework: RegistryFramework;
  requested: string[];
  resolved: string[];
  lockKeys: string[];
  files: RegistryPlanFile[];
  dependencies: RegistryPlanDependency[];
  changes: TransactionChange[];
  catalogSha256: string;
  signatureKeyId: string;
  provenance: Array<{
    lockKey: string;
    definitionSha256: string;
    generatorSha256: string;
    templateSha256: string;
  }>;
}

export type RegistryPlanResult =
  | { ok: true; plan: RegistryInstallPlan }
  | { ok: false; error: { code: string; message: string; path?: string; conflicts?: unknown[] } };

export interface PlanInstallOptions {
  rootDir: string;
  artifacts: string[];
  framework: string;
  registry?: BuiltRegistry;
  /** Read-only planning for a new scaffold; does not create its root. */
  allowMissingRoot?: boolean;
}

function failure(code: string, message: string, extras: Record<string, unknown> = {}): RegistryPlanResult {
  return { ok: false, error: { code, message, ...extras } } as RegistryPlanResult;
}

function normalizeArtifact(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dependencyVersion(dependency: RegistryDependency): string {
  if (dependency.name === 'react' || dependency.name === 'react-dom') return '18.3.1';
  if (dependency.name === 'svelte') return '5.46.4';
  if (dependency.name === 'solid-js') return '1.9.13';
  return dependency.version;
}

function dependencyCompatible(actual: string, required: string): boolean {
  if (actual.startsWith('file:') || actual.startsWith('workspace:')) return true;
  if (actual === required || actual === `^${required}` || actual === `~${required}`) return true;
  const major = Number(actual.replace(/^[^0-9]*/, '').split('.')[0]);
  if (required === '>=18.2.0 <20') return major === 18 || major === 19;
  if (required === '>=5.0.0 <6') return major === 5;
  if (required === '>=1.8.0 <2') return major === 1;
  return false;
}

function resolveArtifacts(registry: BuiltRegistry, requested: string[]): RegistryManifest[] | undefined {
  const resolved: RegistryManifest[] = [];
  const visited = new Set<string>();
  const visit = (manifest: RegistryManifest) => {
    if (visited.has(manifest.slug)) return;
    manifest.artifactDependencies.forEach((slug) => {
      const dependency = registry.bySlug[slug];
      if (dependency) visit(dependency);
    });
    visited.add(manifest.slug);
    resolved.push(manifest);
  };
  for (const value of requested) {
    const normalized = normalizeArtifact(value);
    const manifest = registry.bySlug[normalized] ?? registry.artifacts.find((candidate) => normalizeArtifact(candidate.name) === normalized);
    if (!manifest) return undefined;
    visit(manifest);
  }
  return resolved;
}

function readPackageJson(rootDir: string): { pathname: string; source: string | undefined; value: Record<string, unknown> } | RegistryPlanResult {
  const pathname = path.join(rootDir, 'package.json');
  if (!existsSync(pathname)) return { pathname, source: undefined, value: { name: 'uifn-source-consumer', private: true, version: '0.0.0' } };
  try {
    const source = readFileSync(pathname, 'utf8');
    const value = JSON.parse(source) as Record<string, unknown>;
    return { pathname, source, value };
  } catch {
    return failure('UIFN_REGISTRY_PACKAGE_JSON_INVALID', 'Consumer package.json is not valid JSON.');
  }
}

export function inferFrameworkDependencies(manifest: RegistryManifest, framework: RegistryFramework): RegistryDependency[] {
  const target = manifest.frameworks[framework];
  const dependencies = structuredClone(target.dependencies);
  const importsRecipes = target.files.some((file) => /(?:from\s+|import\s*)['"]@uifn\/recipes(?:\/[^'"]*)?['"]/.test(file.contents));
  if (importsRecipes && !dependencies.some((dependency) => dependency.name === '@uifn/recipes')) {
    dependencies.push({ name: '@uifn/recipes', version: '0.0.1', relationship: 'runtime' });
  }
  return dependencies;
}

function lockEntry(manifest: RegistryManifest, framework: RegistryFramework): UifnLockFileEntry {
  const target = manifest.frameworks[framework];
  return {
    name: manifest.name,
    slug: manifest.slug,
    kind: manifest.kind,
    version: manifest.version,
    canonicalVersion: manifest.canonicalVersion,
    generatorVersion: manifest.generatorVersion,
    framework,
    mode: 'source',
    license: manifest.license,
    dependencies: inferFrameworkDependencies(manifest, framework),
    files: target.files.map((file) => ({ path: file.destination, sourceSha256: file.sourceSha256, outputSha256: file.outputSha256, installedSha256: file.outputSha256 })),
    provenance: {
      source: manifest.provenance.source,
      sourcePolicy: manifest.provenance.sourcePolicy,
      definitionSha256: manifest.definitionSha256,
      generatorSha256: manifest.generatorSha256,
      templateSha256: target.templateSha256,
    },
  };
}

function compareFile(rootDir: string, relativePath: string, contents: string, previous?: UifnLockFileEntry): RegistryPlanFile | RegistryPlanResult {
  try { assertContainedPath(rootDir, relativePath); } catch (cause) {
    return failure(typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : 'UIFN_REGISTRY_PATH_ESCAPE', cause instanceof Error ? cause.message : String(cause), { path: relativePath });
  }
  const nextSha256 = checksumContent(contents);
  const absolute = path.join(rootDir, relativePath);
  if (!existsSync(absolute)) return { path: relativePath, operation: 'create', nextSha256 };
  const previousSha256 = checksumFile(rootDir, relativePath);
  if (previousSha256 === nextSha256) return { path: relativePath, operation: 'unchanged', previousSha256, nextSha256 };
  const tracked = previous?.files.find((file) => file.path === relativePath);
  if (!tracked || tracked.installedSha256 !== previousSha256) {
    return failure('UIFN_REGISTRY_DIRTY_CONFLICT', `Refusing to overwrite a locally modified file: ${relativePath}`, { path: relativePath, conflicts: [{ path: relativePath, baseSha256: tracked?.installedSha256, localSha256: previousSha256, incomingSha256: nextSha256 }] });
  }
  return { path: relativePath, operation: 'update', previousSha256, nextSha256 };
}

export function planInstall(options: PlanInstallOptions): RegistryPlanResult {
  if (!REQUIRED_FRAMEWORKS.includes(options.framework as RegistryFramework)) return failure('UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK', `Unsupported framework: ${options.framework}`);
  if (!options.artifacts.length) return failure('UIFN_REGISTRY_USAGE', 'At least one artifact is required.');
  const framework = options.framework as RegistryFramework;
  const registry = options.registry ?? buildRegistry();
  if (!registry.ok) return failure(registry.errors[0]?.code ?? 'UIFN_REGISTRY_CATALOG_INVALID', registry.errors[0]?.message ?? 'Registry catalog validation failed.');
  const manifests = resolveArtifacts(registry, options.artifacts);
  if (!manifests) return failure('UIFN_REGISTRY_ARTIFACT_NOT_FOUND', `Unknown registry artifact in: ${options.artifacts.join(', ')}`);

  const rootDir = path.resolve(options.rootDir);
  if (!existsSync(rootDir) && !options.allowMissingRoot) return failure('UIFN_REGISTRY_PROJECT_ROOT_MISSING', 'Consumer project root does not exist.');
  try { assertContainedPath(rootDir, 'package.json'); } catch (cause) {
    return failure(typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : 'UIFN_REGISTRY_PATH_ESCAPE', cause instanceof Error ? cause.message : String(cause));
  }
  let lockfile: UifnLockFile;
  try { lockfile = readLockFile(rootDir, { catalogSha256: registry.trust.catalogSha256, signatureKeyId: registry.trust.keyId }); }
  catch (cause) { return failure('UIFN_REGISTRY_LOCK_INVALID', cause instanceof Error ? cause.message : String(cause)); }

  const files: RegistryPlanFile[] = [];
  const sourceChanges: TransactionChange[] = [];
  for (const manifest of manifests) {
    const previous = lockfile.items[manifest.lockKey];
    if (previous && previous.framework !== framework) return failure('UIFN_REGISTRY_FRAMEWORK_CONFLICT', `${manifest.slug} is already installed for ${previous.framework}.`);
    for (const template of manifest.frameworks[framework].files) {
      const comparison = compareFile(rootDir, template.destination, template.contents, previous);
      if ('ok' in comparison) return comparison;
      comparison.sourceSha256 = template.sourceSha256;
      files.push(comparison);
      if (comparison.operation !== 'unchanged') sourceChanges.push({ path: template.destination, operation: comparison.operation, contents: template.contents, expectedSha256: comparison.previousSha256 });
    }
  }

  const packageResult = readPackageJson(rootDir);
  if ('ok' in packageResult) return packageResult;
  const packageJson = structuredClone(packageResult.value);
  const packageDependencies = { ...((packageJson.dependencies && typeof packageJson.dependencies === 'object' && !Array.isArray(packageJson.dependencies)) ? packageJson.dependencies as Record<string, string> : {}) };
  const dependencyMap = new Map<string, RegistryDependency>();
  manifests.forEach((manifest) => inferFrameworkDependencies(manifest, framework).forEach((dependency) => dependencyMap.set(dependency.name, dependency)));
  const dependencies: RegistryPlanDependency[] = [];
  for (const dependency of [...dependencyMap.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const current = packageDependencies[dependency.name];
    if (current && !dependencyCompatible(current, dependency.version)) return failure('UIFN_REGISTRY_DEPENDENCY_CONFLICT', `Dependency ${dependency.name}@${current} does not satisfy ${dependency.version}.`);
    const resolvedVersion = current ?? dependencyVersion(dependency);
    dependencies.push({ ...dependency, operation: current ? 'present' : 'add', resolvedVersion });
    if (!current) packageDependencies[dependency.name] = resolvedVersion;
  }
  packageJson.dependencies = Object.fromEntries(Object.entries(packageDependencies).sort(([left], [right]) => left.localeCompare(right)));
  const packageContents = `${JSON.stringify(packageJson, null, 2)}\n`;
  const packageNextSha256 = checksumContent(packageContents);
  const packagePreviousSha256 = packageResult.source === undefined ? undefined : checksumContent(packageResult.source);
  const packageComparison: RegistryPlanFile = packagePreviousSha256 === packageNextSha256
    ? { path: 'package.json', operation: 'unchanged', previousSha256: packagePreviousSha256, nextSha256: packageNextSha256 }
    : { path: 'package.json', operation: packagePreviousSha256 ? 'update' : 'create', previousSha256: packagePreviousSha256, nextSha256: packageNextSha256 };
  files.push(packageComparison);
  if (packageComparison.operation !== 'unchanged') sourceChanges.push({ path: 'package.json', operation: packageComparison.operation, contents: packageContents, expectedSha256: packagePreviousSha256 });

  const nextLock: UifnLockFile = {
    schemaVersion: 2,
    registry: 'https://uifn.dev/registry',
    catalogSha256: registry.trust.catalogSha256,
    signatureKeyId: registry.trust.keyId,
    items: { ...lockfile.items },
  };
  manifests.forEach((manifest) => { nextLock.items[manifest.lockKey] = lockEntry(manifest, framework); });
  const metadata = [
    { path: '.uifn/registry.lock', contents: serializeLockFile(nextLock) },
    { path: '.uifn/selected-components.json', contents: serializeSelectedComponents(selectedFromLock(nextLock)) },
  ];
  for (const entry of metadata) {
    try { assertContainedPath(rootDir, entry.path); } catch (cause) { return failure(typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : 'UIFN_REGISTRY_PATH_ESCAPE', cause instanceof Error ? cause.message : String(cause)); }
    const absolute = path.join(rootDir, entry.path);
    const previousSha256 = existsSync(absolute) ? checksumFile(rootDir, entry.path) : undefined;
    const nextSha256 = checksumContent(entry.contents);
    const comparison: RegistryPlanFile = previousSha256 === nextSha256
      ? { path: entry.path, operation: 'unchanged', previousSha256, nextSha256 }
      : { path: entry.path, operation: previousSha256 ? 'update' : 'create', previousSha256, nextSha256 };
    files.push(comparison);
    if (comparison.operation !== 'unchanged') sourceChanges.push({ path: entry.path, operation: comparison.operation, contents: entry.contents, expectedSha256: previousSha256 });
  }

  return { ok: true, plan: {
    schemaVersion: 1,
    rootDir,
    framework,
    requested: options.artifacts.map(normalizeArtifact),
    resolved: manifests.map((manifest) => manifest.slug),
    lockKeys: manifests.map((manifest) => manifest.lockKey),
    files,
    dependencies,
    changes: sourceChanges,
    catalogSha256: registry.trust.catalogSha256,
    signatureKeyId: registry.trust.keyId,
    provenance: manifests.map((manifest) => ({ lockKey: manifest.lockKey, definitionSha256: manifest.definitionSha256, generatorSha256: manifest.generatorSha256, templateSha256: manifest.frameworks[framework].templateSha256 })),
  } };
}
