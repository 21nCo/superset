import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planInstall } from '../plan';
import { checksumContent } from '../lockfile';
import { commitTransaction, type TransactionChange } from '../transaction';
import { decodePreset, encodePreset, normalizePreset } from './codec';
import { assertApprovedInit, compilePreset, type PresetCompilePlan } from './compiler';
import { fixtureCss, fixtureMarkup } from './fixtures';
import { APPROVED_SUPPORT_MATRIX, type ApprovedTemplate, type PartialPresetDomain, type UIFnPresetV1 } from './schema';
import { presetFailure, UIFnPresetError } from './errors';

export const PRESET_STATE_PATH = '.uifn/preset.json';
export const PRESET_THEME_PATH = 'src/uifn-theme.css';
export const PRESET_APP_PATH = 'src/App.tsx';
export const PRESET_MAIN_PATH = 'src/main.tsx';

export interface PresetProjectState {
  schemaVersion: 1;
  code: string;
  preset: UIFnPresetV1;
  template: ApprovedTemplate;
  files: Record<string, string>;
}

export interface PresetMutationOptions {
  rootDir: string;
  preset?: UIFnPresetV1 | string;
  template?: ApprovedTemplate;
  dryRun?: boolean;
  only?: PartialPresetDomain[];
  faultAfterWrites?: number;
  createRoot?: boolean;
}

export interface PresetMutationResult {
  ok: boolean;
  dryRun: boolean;
  written: string[];
  unchanged: string[];
  rolledBack?: boolean;
  plan?: {
    code: string;
    url: string;
    files: Array<{ path: string; operation: 'create' | 'update' | 'unchanged' }>;
    artifacts?: string[];
    commands: PresetCompilePlan['commands'];
  };
  error?: { code: string; message: string; path?: string; conflicts?: unknown[] };
}

function flag(code: string, message: string, extras: Record<string, unknown> = {}): PresetMutationResult {
  return { ok: false, dryRun: false, written: [], unchanged: [], error: { code, message, ...extras } };
}

function resolveInput(options: PresetMutationOptions): UIFnPresetV1 {
  if (typeof options.preset === 'string') return decodePreset(options.preset);
  if (options.preset) return normalizePreset(options.preset);
  throw new UIFnPresetError('UIFN_PRESET_USAGE', 'A preset object or code is required.');
}

function serializeState(plan: PresetCompilePlan, files: Record<string, string>, previous: Record<string, string> = {}): string {
  const managed = {
    ...previous,
    ...Object.fromEntries(
    Object.entries(files)
      .filter(([relativePath]) => relativePath !== PRESET_STATE_PATH)
      .map(([relativePath, contents]) => [relativePath, checksumContent(contents)]),
    ),
  };
  const state: PresetProjectState = {
    schemaVersion: 1,
    code: plan.code,
    preset: plan.preset,
    template: plan.template,
    files: managed,
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

function themeCss(plan: PresetCompilePlan): string {
  return `${plan.css.fonts}\n${plan.css.light}\n${plan.css.dark}\n${fixtureCss()}\nhtml,body,#root{min-height:100%;margin:0;}\nbody{background:var(--uifn-color-surface-canvas);color:var(--uifn-color-text-primary);}\n`;
}

function appSource(plan: PresetCompilePlan): string {
  return `export function App() {\n  return (\n    <div dangerouslySetInnerHTML={{ __html: ${JSON.stringify(fixtureMarkup(plan))} }} />\n  );\n}\n`;
}

function mainSource(): string {
  return `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App';\nimport '@uifn/components/styles.css';\nimport './uifn-theme.css';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
}

function indexHtml(): string {
  return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>uifn app</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
}

function viteConfig(): string {
  return `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
}

function tsconfig(): string {
  return `{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "ESNext",\n    "moduleResolution": "Bundler",\n    "jsx": "react-jsx",\n    "strict": true,\n    "skipLibCheck": true\n  },\n  "include": ["src"]\n}\n`;
}

function mergePackageDependencies(
  source: string,
  dependencies: Array<{ name: string; resolvedVersion: string; operation: 'add' | 'present' }>,
): string {
  const parsed = JSON.parse(source) as { dependencies?: Record<string, string> };
  const next = { ...(parsed.dependencies ?? {}) };
  for (const dependency of dependencies) {
    if (!next[dependency.name]) next[dependency.name] = dependency.resolvedVersion;
  }
  parsed.dependencies = Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function packageJson(plan: PresetCompilePlan): string {
  const dependencies = Object.fromEntries(plan.project.packages.map((entry) => [entry.name, entry.version]).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify({
    name: 'uifn-app',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
    },
    dependencies,
    devDependencies: {
      '@vitejs/plugin-react': '4.3.4',
      typescript: '5.6.3',
      vite: '5.4.21',
    },
  }, null, 2)}\n`;
}

function desiredFiles(plan: PresetCompilePlan, domains: Array<'full' | PartialPresetDomain>, scaffold = true, previous: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  if (domains.includes('full') || domains.includes('theme') || domains.includes('font')) files[PRESET_THEME_PATH] = themeCss(plan);
  if (domains.includes('full') && scaffold) {
    files['index.html'] = indexHtml();
    files['vite.config.ts'] = viteConfig();
    files['tsconfig.json'] = tsconfig();
    files['package.json'] = packageJson(plan);
    files[PRESET_APP_PATH] = appSource(plan);
    files[PRESET_MAIN_PATH] = mainSource();
    files['README.md'] = `# uifn app\n\nPreset \`${plan.code}\`\n\n\`\`\`bash\n${plan.commands.decode}\n${plan.commands.apply}\n\`\`\`\n`;
  }
  files[PRESET_STATE_PATH] = serializeState(plan, files, previous);
  return files;
}

const THEME_FIELDS = ['style', 'baseColor', 'theme', 'chartColor', 'radius', 'density', 'menuTreatment'] as const;
const FONT_FIELDS = ['font', 'headingFont'] as const;

function partialPreset(rootDir: string, incoming: UIFnPresetV1, only?: PartialPresetDomain[]): UIFnPresetV1 {
  if (!only?.length) return incoming;
  const current = readProjectPreset(rootDir);
  if (!current.ok) {
    throw new UIFnPresetError('UIFN_PRESET_PROJECT_MISSING', 'Partial application requires an existing .uifn/preset.json state file.');
  }
  const merged = { ...current.state.preset };
  if (only.includes('theme')) for (const field of THEME_FIELDS) merged[field] = incoming[field] as never;
  if (only.includes('font')) for (const field of FONT_FIELDS) merged[field] = incoming[field] as never;
  return normalizePreset(merged);
}

function assertExistingProject(rootDir: string): void {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new UIFnPresetError('UIFN_PRESET_PROJECT_AMBIGUOUS', 'Existing-project application requires a package.json at the project root.');
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    if (!dependencies.react) {
      throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_COMBINATION', 'The approved V1 existing-project adapter supports React projects only.');
    }
  } catch (cause) {
    if (cause instanceof UIFnPresetError) throw cause;
    throw new UIFnPresetError('UIFN_PRESET_INVALID_JSON', 'Existing project package.json could not be parsed.');
  }
}

function readManagedHashes(rootDir: string): Record<string, string> {
  const pathname = path.join(rootDir, PRESET_STATE_PATH);
  if (!existsSync(pathname)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pathname, 'utf8')) as PresetProjectState;
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

function planFileChanges(rootDir: string, files: Record<string, string>): { changes: TransactionChange[]; summary: Array<{ path: string; operation: 'create' | 'update' | 'unchanged' }>; error?: PresetMutationResult } {
  const changes: TransactionChange[] = [];
  const summary: Array<{ path: string; operation: 'create' | 'update' | 'unchanged' }> = [];
  const tracked = readManagedHashes(rootDir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(rootDir, relativePath);
    if (!existsSync(absolute)) {
      summary.push({ path: relativePath, operation: 'create' });
      changes.push({ path: relativePath, operation: 'create', contents });
      continue;
    }
    const previousSha256 = checksumContent(readFileSync(absolute));
    const nextSha256 = checksumContent(contents);
    if (previousSha256 === nextSha256) {
      summary.push({ path: relativePath, operation: 'unchanged' });
      continue;
    }
    const baseSha256 = tracked[relativePath];
    if (relativePath !== PRESET_STATE_PATH && baseSha256 && baseSha256 !== previousSha256) {
      return {
        changes: [],
        summary: [],
        error: flag('UIFN_REGISTRY_DIRTY_CONFLICT', `Refusing to overwrite a locally modified file: ${relativePath}`, {
          path: relativePath,
          conflicts: [{ path: relativePath, baseSha256, localSha256: previousSha256, incomingSha256: nextSha256 }],
        }),
      };
    }
    summary.push({ path: relativePath, operation: 'update' });
    changes.push({ path: relativePath, operation: 'update', contents, expectedSha256: previousSha256 });
  }
  return { changes, summary };
}

export function readProjectPreset(rootDir: string): { ok: true; state: PresetProjectState } | { ok: false; error: { code: string; message: string } } {
  const pathname = path.join(rootDir, PRESET_STATE_PATH);
  if (!existsSync(pathname)) return presetFailure('UIFN_PRESET_PROJECT_MISSING', 'No .uifn/preset.json was found in this project.');
  try {
    const parsed = JSON.parse(readFileSync(pathname, 'utf8')) as PresetProjectState;
    const preset = normalizePreset(parsed.preset);
    const code = encodePreset(preset);
    return { ok: true, state: { schemaVersion: 1, code, preset, template: parsed.template ?? 'react-vite', files: parsed.files ?? {} } };
  } catch (cause) {
    if (cause instanceof UIFnPresetError) return presetFailure(cause.code, cause.message, cause.details);
    return presetFailure('UIFN_PRESET_INVALID_JSON', 'Project preset state could not be parsed.');
  }
}

export function resolveProjectPreset(rootDir: string) {
  const resolved = readProjectPreset(rootDir);
  if (!resolved.ok) return resolved;
  const plan = compilePreset(resolved.state.preset, resolved.state.template);
  return { ok: true as const, ...resolved.state, url: plan.url, commands: plan.commands, deviations: resolved.state.code === encodePreset(resolved.state.preset) ? [] : ['normalized-code'] };
}

function mutate(options: PresetMutationOptions, mode: 'init' | 'apply'): PresetMutationResult {
  const template = options.template ?? 'react-vite';
  const only = options.only?.length ? options.only : undefined;
  try {
    const incomingPreset = resolveInput(options);
    const preset = mode === 'apply' ? partialPreset(path.resolve(options.rootDir), incomingPreset, only) : incomingPreset;
    assertApprovedInit(preset, template);
    const plan = compilePreset(preset, template);
    const rootDir = path.resolve(options.rootDir);
    if (mode === 'init') {
      if (!existsSync(rootDir)) {
        if (options.dryRun) {
          const files = Object.keys(desiredFiles(plan, ['full'])).map((relativePath) => ({ path: relativePath, operation: 'create' as const }));
          return { ok: true, dryRun: true, written: [], unchanged: [], plan: { code: plan.code, url: plan.url, files, artifacts: plan.preset.installMode === 'source' ? plan.project.artifacts : [], commands: plan.commands } };
        }
        mkdirSync(rootDir, { recursive: true });
      } else if (readdirSync(rootDir).length > 0 && !existsSync(path.join(rootDir, PRESET_STATE_PATH))) {
        return flag('UIFN_PRESET_PROJECT_AMBIGUOUS', 'Refusing to initialize a non-empty directory that is not already a uifn preset project.');
      }
    } else if (!existsSync(rootDir)) {
      return flag('UIFN_PRESET_PROJECT_MISSING', 'Consumer project root does not exist.');
    } else {
      assertExistingProject(rootDir);
    }

    const domains: Array<'full' | PartialPresetDomain> = mode === 'init' || !only ? ['full'] : only;
    const previousManaged = readManagedHashes(rootDir);
    const files = desiredFiles(plan, domains, mode === 'init', previousManaged);
    if (mode === 'apply' && domains.includes('full')) {
      files['package.json'] = mergePackageDependencies(readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
        plan.project.packages.map((entry) => ({ name: entry.name, resolvedVersion: entry.version, operation: 'add' as const })));
      files[PRESET_STATE_PATH] = serializeState(plan, files, previousManaged);
    }

    let artifactChanges: TransactionChange[] = [];
    let artifactFiles: Array<{ path: string; operation: 'create' | 'update' | 'unchanged' }> = [];
    if ((mode === 'init' || !only) && plan.preset.installMode === 'source') {
      const installed = planInstall({ rootDir, artifacts: [...plan.project.artifacts], framework: plan.preset.framework });
      if (!installed.ok) return { ok: false, dryRun: Boolean(options.dryRun), written: [], unchanged: [], error: installed.error };
      if (files['package.json']) {
        files['package.json'] = mergePackageDependencies(files['package.json'], installed.plan.dependencies);
        files[PRESET_STATE_PATH] = serializeState(plan, files, previousManaged);
      }
      artifactChanges = installed.plan.changes.filter((change) => change.path !== 'package.json');
      artifactFiles = installed.plan.files
        .filter((file) => file.path !== 'package.json')
        .map((file) => ({ path: file.path, operation: file.operation }));
    }

    const planned = planFileChanges(rootDir, files);
    if (planned.error) return { ...planned.error, dryRun: Boolean(options.dryRun) };

    const summary = [...planned.summary, ...artifactFiles.filter((file) => !planned.summary.some((entry) => entry.path === file.path))];
    if (options.dryRun) {
      return { ok: true, dryRun: true, written: [], unchanged: summary.filter((file) => file.operation === 'unchanged').map((file) => file.path), plan: { code: plan.code, url: plan.url, files: summary, artifacts: plan.preset.installMode === 'source' ? plan.project.artifacts : [], commands: plan.commands } };
    }

    const committed = commitTransaction({ rootDir, changes: [...planned.changes, ...artifactChanges] }, { faultAfterWrites: options.faultAfterWrites });
    if (!committed.ok) return { ok: false, dryRun: false, written: [], unchanged: [], rolledBack: committed.rolledBack, error: committed.error };
    return {
      ok: true,
      dryRun: false,
      written: committed.committed,
      unchanged: summary.filter((file) => file.operation === 'unchanged').map((file) => file.path),
      plan: { code: plan.code, url: plan.url, files: summary, artifacts: plan.preset.installMode === 'source' ? plan.project.artifacts : [], commands: plan.commands },
    };
  } catch (cause) {
    if (cause instanceof UIFnPresetError) return flag(cause.code, cause.message, cause.details);
    return flag('UIFN_REGISTRY_CLI_ERROR', cause instanceof Error ? cause.message : String(cause));
  }
}

export function initProject(options: PresetMutationOptions): PresetMutationResult {
  return mutate(options, 'init');
}

export function applyPreset(options: PresetMutationOptions): PresetMutationResult {
  if (options.only?.some((domain) => !APPROVED_SUPPORT_MATRIX.partialDomains.includes(domain))) {
    return flag('UIFN_PRESET_UNKNOWN_OPTION', `Unsupported partial apply domain: ${options.only.join(', ')}.`, {
      allowed: APPROVED_SUPPORT_MATRIX.partialDomains,
    });
  }
  return mutate(options, 'apply');
}
