import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli';
import { encodePreset, normalizePreset } from '../preset';
import { PRESET_STATE_PATH, applyPreset, initProject } from '../preset/project';

function snapshot(rootDir: string): string {
  const entries: string[] = [];
  const walk = (relative = '') => {
    if (!existsSync(path.join(rootDir, relative))) return;
    for (const name of readdirSync(path.join(rootDir, relative)).sort()) {
      const child = path.join(relative, name);
      const pathname = path.join(rootDir, child);
      try {
        entries.push(`${child}\0${createHash('sha256').update(readFileSync(pathname)).digest('hex')}`);
      } catch {
        walk(child);
      }
    }
  };
  walk();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

async function withProject(callback: (rootDir: string) => Promise<void> | void) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'uifn-preset-cli-'));
  try { await callback(rootDir); } finally { rmSync(rootDir, { recursive: true, force: true }); }
}

describe('preset CLI and project workflows', () => {
  const code = encodePreset({ style: 'atlas', baseColor: 'stone', density: 'compact' });

  it('encodes, decodes, and prints a share URL', async () => {
    const encoded = await runCli(['preset', 'encode', '--style', 'atlas', '--base-color', 'stone', '--density', 'compact', '--json'], { stdout: () => {}, stderr: () => {} });
    expect(encoded.exitCode).toBe(0);
    expect(encoded.result).toMatchObject({ ok: true, code, preset: normalizePreset({ style: 'atlas', baseColor: 'stone', density: 'compact' }) });
    const decoded = await runCli(['preset', 'decode', code, '--json'], { stdout: () => {}, stderr: () => {} });
    expect(decoded.result).toMatchObject({ ok: true, code, url: expect.stringContaining(code) });
  });

  it('initializes a react-vite project from a dry-run plan, then commits idempotently', async () => {
    await withProject(async (parent) => {
      const rootDir = path.join(parent, 'app');
      const dry = initProject({ rootDir, preset: code, dryRun: true });
      expect(dry.ok).toBe(true);
      expect(dry.dryRun).toBe(true);
      expect(existsSync(rootDir)).toBe(false);
      const first = initProject({ rootDir, preset: code });
      expect(first.ok).toBe(true);
      expect(existsSync(path.join(rootDir, '.uifn/preset.json'))).toBe(true);
      expect(readFileSync(path.join(rootDir, 'src/uifn-theme.css'), 'utf8')).toContain('--uifn-color-accent-solid:');
      const after = snapshot(rootDir);
      const second = applyPreset({ rootDir, preset: code });
      expect(second.ok).toBe(true);
      expect(second.written).toEqual([]);
      expect(snapshot(rootDir)).toBe(after);
    });
  });

  it('partially applies theme/font without installing source artifacts', async () => {
    await withProject(async (rootDir) => {
      expect(initProject({ rootDir, preset: encodePreset({ installMode: 'package' }) }).ok).toBe(true);
      expect(existsSync(path.join(rootDir, 'components'))).toBe(false);
      const next = encodePreset({ installMode: 'package', radius: 'xl', font: 'ibm-plex-sans' });
      const result = applyPreset({ rootDir, preset: next, only: ['theme', 'font'] });
      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(rootDir, 'src/uifn-theme.css'), 'utf8')).toContain('IBM Plex Sans');
      expect(existsSync(path.join(rootDir, 'components'))).toBe(false);
    });
  });

  it('merges dependencies into existing React projects without replacing consumer files', async () => {
    await withProject(async (rootDir) => {
      writeFileSync(path.join(rootDir, 'package.json'), `${JSON.stringify({ name: 'consumer', scripts: { test: 'vitest' }, dependencies: { react: '^18.3.1' } }, null, 2)}\n`);
      writeFileSync(path.join(rootDir, 'README.md'), '# consumer-owned\n');
      const result = applyPreset({ rootDir, preset: code });
      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(rootDir, 'README.md'), 'utf8')).toBe('# consumer-owned\n');
      const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string>; dependencies: Record<string, string> };
      expect(manifest.name).toBe('consumer');
      expect(manifest.scripts.test).toBe('vitest');
      expect(manifest.dependencies['@uifn/components-react']).toBeDefined();
      expect(manifest.dependencies['lucide-react']).toBeDefined();
    });
  });

  it('rejects ambiguous and unsupported existing projects without writes', async () => {
    await withProject(async (rootDir) => {
      const missingManifest = applyPreset({ rootDir, preset: code });
      expect(missingManifest).toMatchObject({ ok: false, error: { code: 'UIFN_PRESET_PROJECT_AMBIGUOUS' } });
      writeFileSync(path.join(rootDir, 'package.json'), '{"dependencies":{"svelte":"5.0.0"}}\n');
      const unsupported = applyPreset({ rootDir, preset: code });
      expect(unsupported).toMatchObject({ ok: false, error: { code: 'UIFN_PRESET_UNSUPPORTED_COMBINATION' } });
      expect(existsSync(path.join(rootDir, PRESET_STATE_PATH))).toBe(false);
    });
  });

  it('rejects dirty consumer edits and interrupted writes restore bytes', async () => {
    await withProject(async (rootDir) => {
      expect(initProject({ rootDir, preset: code }).ok).toBe(true);
      const theme = path.join(rootDir, 'src/uifn-theme.css');
      writeFileSync(theme, '/* consumer edit */\n');
      const before = snapshot(rootDir);
      const conflicted = applyPreset({ rootDir, preset: encodePreset({ style: 'nova' }) });
      expect(conflicted).toMatchObject({ ok: false, error: { code: 'UIFN_REGISTRY_DIRTY_CONFLICT' } });
      expect(snapshot(rootDir)).toBe(before);
    });
    await withProject(async (parent) => {
      const rootDir = path.join(parent, 'interrupted');
      const result = initProject({ rootDir, preset: code, faultAfterWrites: 1 });
      expect(result).toMatchObject({ ok: false, rolledBack: true, error: { code: 'UIFN_REGISTRY_TRANSACTION_INTERRUPTED' } });
      expect(existsSync(path.join(rootDir, 'src/uifn-theme.css'))).toBe(false);
    });
  });

  it('wires init/apply/resolve through the CLI', async () => {
    await withProject(async (rootDir) => {
      const init = await runCli(['init', '--preset', code, '--dry-run', '--json'], { cwd: rootDir, stdout: () => {}, stderr: () => {} });
      expect(init.result).toMatchObject({ ok: true, dryRun: true, plan: { code } });
      const committed = await runCli(['init', '--preset', code, '--json'], { cwd: rootDir, stdout: () => {}, stderr: () => {} });
      expect(committed.exitCode).toBe(0);
      const resolved = await runCli(['preset', 'resolve', '--json'], { cwd: rootDir, stdout: () => {}, stderr: () => {} });
      expect(resolved.result).toMatchObject({ ok: true, code, preset: normalizePreset({ style: 'atlas', baseColor: 'stone', density: 'compact' }) });
    });
  });

  it('rejects encoded svelte/solid values for V1 init/apply', async () => {
    await withProject(async (rootDir) => {
      const svelte = encodePreset({ framework: 'svelte' });
      const result = initProject({ rootDir, preset: svelte, dryRun: true });
      expect(result).toMatchObject({ ok: false, error: { code: 'UIFN_PRESET_UNSUPPORTED_COMBINATION' } });
      expect(existsSync(rootDir) && readdirSync(rootDir).length > 0).toBe(false);
    });
  });

  it('plans source-install artifacts without writing on dry-run', async () => {
    await withProject(async (parent) => {
      const rootDir = path.join(parent, 'source-app');
      const sourceCode = encodePreset({ installMode: 'source' });
      const dry = initProject({ rootDir, preset: sourceCode, dryRun: true });
      expect(dry.ok).toBe(true);
      expect(dry.plan?.artifacts).toEqual(expect.arrayContaining(['button', 'dialog', 'table']));
      expect(existsSync(rootDir)).toBe(false);
      const committed = initProject({ rootDir, preset: sourceCode });
      expect(committed.ok).toBe(true);
      expect(existsSync(path.join(rootDir, '.uifn/preset.json'))).toBe(true);
      expect(existsSync(path.join(rootDir, '.uifn/registry.lock'))).toBe(true);
      expect(existsSync(path.join(rootDir, 'components/uifn/react/button.ts'))).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
      expect(manifest.devDependencies.vite).toBeDefined();
      expect(manifest.dependencies['@uifn/react']).toBeDefined();
      expect(committed.plan?.artifacts).toEqual(expect.arrayContaining(['button']));
    });
  });
});
