import path from 'node:path';
import { addArtifact } from './add';
import { buildRegistry, type BuiltRegistry } from './build-registry';
import { redactDiagnostic } from './diagnostics';
import { diffInstalled } from './diff';
import { planInstall } from './plan';
import { removeInstalled } from './remove';
import { REQUIRED_FRAMEWORKS, type RegistryFramework, type RegistryManifest } from './schema';
import { commitTransaction } from './transaction';
import { updateInstalled } from './update';
import { PRESET_HELP, runApplyCommand, runInitCommand, runPresetCommand } from './preset/cli';

export interface CliResult { exitCode: number; result: unknown }
export interface CliRunOptions { cwd?: string; registryRoot?: string; stdout?: (value: string) => void; stderr?: (value: string) => void }
interface ParsedArgs { command: string; positionals: string[]; flags: Record<string, string | boolean> }

export function listArtifacts() {
  const registry = buildRegistry();
  return { ok: registry.ok, catalogTrusted: registry.trust.ok, artifacts: registry.artifacts.map((manifest) => ({ name: manifest.name, version: manifest.version, canonicalVersion: manifest.canonicalVersion, slug: manifest.slug, kind: manifest.kind, status: manifest.status, license: manifest.license, frameworks: [...REQUIRED_FRAMEWORKS], lockKey: manifest.lockKey })), errors: registry.errors };
}

export function infoArtifact(options: { artifact: string; framework: string; registryRoot?: string }, registry: BuiltRegistry = buildRegistry()): { ok: true; name: string; version: string; canonicalVersion: string; slug: string; kind: RegistryManifest['kind']; framework: RegistryFramework; packageImport: string; sourceFiles: string[]; dependencies: unknown[]; lockKey: string; provenance: RegistryManifest['provenance'] } | { ok: false; error: { code: string; message: string } } {
  if (!REQUIRED_FRAMEWORKS.includes(options.framework as RegistryFramework)) return { ok: false, error: { code: 'UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK', message: `Unsupported framework: ${options.framework}` } };
  if (!registry.ok) {
    const error = registry.errors[0] ?? { code: 'UIFN_REGISTRY_SIGNATURE_INVALID', message: 'The offline registry catalog is not trusted.' };
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const manifest = registry.bySlug[options.artifact] ?? registry.artifacts.find((candidate) => candidate.name.toLowerCase() === options.artifact.toLowerCase());
  if (!manifest) return { ok: false, error: { code: 'UIFN_REGISTRY_ARTIFACT_NOT_FOUND', message: `Unknown registry artifact: ${options.artifact}` } };
  const framework = options.framework as RegistryFramework;
  const target = manifest.frameworks[framework];
  return { ok: true, name: manifest.name, version: manifest.version, canonicalVersion: manifest.canonicalVersion, slug: manifest.slug, kind: manifest.kind, framework, packageImport: target.packageImport, sourceFiles: target.files.map((file) => file.destination), dependencies: target.dependencies, lockKey: manifest.lockKey, provenance: manifest.provenance };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { command, positionals, flags };
}

function printResult(result: unknown, json: boolean, write: (value: string) => void): void {
  write(json || typeof result !== 'string' ? JSON.stringify(result, null, 2) : result);
}

export async function runCli(argv = process.argv.slice(2), options: CliRunOptions = {}): Promise<CliResult> {
  const parsed = parseArgs(argv);
  const rootDir = path.resolve(typeof parsed.flags.cwd === 'string' ? parsed.flags.cwd : options.cwd ?? process.cwd());
  const json = parsed.flags.json === true;
  const dryRun = parsed.flags['dry-run'] === true;
  const stdout = options.stdout ?? ((value) => console.log(value));
  const stderr = options.stderr ?? ((value) => console.error(value));
  try {
    if (parsed.command === 'help' || parsed.command === '--help') {
      const result = PRESET_HELP;
      printResult(result, json, stdout); return { exitCode: 0, result };
    }
    if (parsed.command === 'list') { const result = listArtifacts(); printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result }; }
    if (parsed.command === 'validate') {
      const registry = buildRegistry();
      const result = { ok: registry.ok, artifactCount: registry.artifacts.length, catalogTrusted: registry.trust.ok, catalogSha256: registry.trust.catalogSha256, signatureKeyId: registry.trust.keyId, errors: registry.errors };
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'info') {
      const result = parsed.positionals[0] && typeof parsed.flags.framework === 'string' ? infoArtifact({ artifact: parsed.positionals[0], framework: parsed.flags.framework }) : { ok: false as const, error: { code: 'UIFN_REGISTRY_USAGE', message: 'Usage: uifn info <artifact> --framework <framework>' } };
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'add') {
      const framework = typeof parsed.flags.framework === 'string' ? parsed.flags.framework : '';
      if (!parsed.positionals.length) { const result = { ok: false, error: { code: 'UIFN_REGISTRY_USAGE', message: 'Usage: uifn add <artifact...> --framework <framework> [--dry-run]' } }; printResult(result, json, stderr); return { exitCode: 1, result }; }
      if (parsed.positionals.length === 1) { const result = addArtifact({ rootDir, artifact: parsed.positionals[0], framework, dryRun }); printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result }; }
      const planned = planInstall({ rootDir, artifacts: parsed.positionals, framework });
      if (!planned.ok) { printResult(planned, json, stderr); return { exitCode: 1, result: planned }; }
      const result = dryRun ? { ok: true, dryRun: true, plan: { ...planned.plan, rootDir: undefined, changes: undefined } } : commitTransaction({ rootDir, changes: planned.plan.changes });
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'diff') { const result = diffInstalled(rootDir); printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result }; }
    if (parsed.command === 'update') { const result = updateInstalled({ rootDir, lockKeys: parsed.positionals.length ? parsed.positionals.map((value) => value.includes(':') ? value : `component:${value}`) : undefined, dryRun }); printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result }; }
    if (parsed.command === 'remove') { const result = removeInstalled({ rootDir, lockKeys: parsed.positionals, dryRun }); printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result }; }
    if (parsed.command === 'doctor') {
      const registry = buildRegistry();
      let diff;
      try { diff = diffInstalled(rootDir); } catch (cause) { const result = { ok: false, error: { code: 'UIFN_REGISTRY_LOCK_INVALID', message: cause instanceof Error ? cause.message : String(cause) } }; printResult(result, json, stderr); return { exitCode: 1, result }; }
      const result = { ok: registry.ok && diff.ok, catalogTrusted: registry.trust.ok, catalogSha256: registry.trust.catalogSha256, signatureKeyId: registry.trust.keyId, installedFiles: diff.entries.length, changed: diff.changed, errors: registry.errors };
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'preset') {
      const result = runPresetCommand({ action: parsed.positionals[0] ?? '', positionals: parsed.positionals.slice(1), flags: parsed.flags, rootDir, dryRun });
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'init') {
      const result = runInitCommand({ flags: parsed.flags, rootDir, dryRun });
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    if (parsed.command === 'apply') {
      const result = runApplyCommand({ flags: parsed.flags, rootDir, dryRun });
      printResult(result, json, result.ok ? stdout : stderr); return { exitCode: result.ok ? 0 : 1, result };
    }
    const result = { ok: false, error: { code: 'UIFN_REGISTRY_UNKNOWN_COMMAND', message: `Unknown uifn command: ${parsed.command}` } };
    printResult(result, json, stderr); return { exitCode: 1, result };
  } catch (cause) {
    const diagnostic = redactDiagnostic({ code: typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : 'UIFN_REGISTRY_CLI_ERROR', message: cause instanceof Error ? cause.message : String(cause), path: rootDir });
    const result = { ok: false, error: diagnostic };
    printResult(result, json, stderr); return { exitCode: 1, result };
  }
}
