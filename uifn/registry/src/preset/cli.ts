import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compilePreset, themeTokenDocument } from './compiler';
import { decodePreset, encodePreset, normalizePreset, parsePresetJson } from './codec';
import { UIFnPresetError } from './errors';
import { applyPreset, initProject, resolveProjectPreset } from './project';
import { PRESET_CREATE_ORIGIN, PRESET_FIELD_ORDER, type PartialPresetDomain, type UIFnPresetInput } from './schema';
import { presetShareUrl } from './url';

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function presetFromFlags(flags: Record<string, string | boolean>, extra?: string): ReturnType<typeof normalizePreset> {
  if (flags['from-json'] !== undefined && typeof flags['from-json'] !== 'string') throw new UIFnPresetError('UIFN_PRESET_USAGE', '--from-json requires a value.');
  if (extra !== undefined && !extra.startsWith('{')) throw new UIFnPresetError('UIFN_PRESET_USAGE', 'Expected a JSON preset object.');
  if (typeof flags['from-json'] === 'string') return parsePresetJson(flags['from-json']);
  if (extra?.startsWith('{')) return parsePresetJson(extra);
  const input: UIFnPresetInput = {};
  for (const field of PRESET_FIELD_ORDER) {
    const kebab = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const value = flags[field] ?? flags[kebab] ?? flags[kebabToCamel(kebab)];
    if (value !== undefined && typeof value !== 'string') throw new UIFnPresetError('UIFN_PRESET_USAGE', `--${kebab} requires a value.`);
    if (typeof value === 'string') input[field] = value as never;
  }
  return normalizePreset(input);
}

export function runPresetCommand(options: {
  action: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  rootDir: string;
  dryRun: boolean;
}): { ok: boolean; [key: string]: unknown } {
  const { action, positionals, flags, rootDir } = options;
  try {
    if (action === 'encode') {
      const preset = presetFromFlags(flags, positionals[0]);
      const code = encodePreset(preset);
      return { ok: true, code, preset, url: presetShareUrl(code) };
    }
    if (action === 'decode') {
      const code = positionals[0] ?? (typeof flags.code === 'string' ? flags.code : '');
      if (!code) return { ok: false, error: { code: 'UIFN_PRESET_USAGE', message: 'Usage: uifn preset decode <code>' } };
      const preset = decodePreset(code);
      return { ok: true, code: encodePreset(preset), preset, url: presetShareUrl(preset) };
    }
    if (action === 'url') {
      const code = positionals[0] ?? (typeof flags.preset === 'string' ? flags.preset : encodePreset(presetFromFlags(flags)));
      const origin = typeof flags.origin === 'string' ? flags.origin : PRESET_CREATE_ORIGIN;
      const preset = decodePreset(code.startsWith('uifn') ? code : encodePreset(presetFromFlags(flags, code)));
      return { ok: true, code: encodePreset(preset), url: presetShareUrl(preset, origin), preset };
    }
    if (action === 'open') {
      const code = positionals[0] ?? (typeof flags.preset === 'string' ? flags.preset : '');
      if (!code) return { ok: false, error: { code: 'UIFN_PRESET_USAGE', message: 'Usage: uifn preset open <code>' } };
      const preset = decodePreset(code);
      const url = presetShareUrl(preset);
      if (!options.dryRun) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
        const launched = spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 });
        if (launched.error || launched.status !== 0) throw new UIFnPresetError('UIFN_PRESET_OPEN_FAILED', 'Could not open the Create editor. Open the returned URL in your browser.', { url });
      }
      return { ok: true, code: encodePreset(preset), url, preset, opened: !options.dryRun, dryRun: options.dryRun };
    }
    if (action === 'resolve') {
      return resolveProjectPreset(rootDir);
    }
    if (action === 'tokens') {
      const preset = positionals[0] ? decodePreset(positionals[0]) : presetFromFlags(flags);
      return { ok: true, code: encodePreset(preset), tokens: themeTokenDocument(preset), compile: compilePreset(preset) };
    }
    return { ok: false, error: { code: 'UIFN_PRESET_USAGE', message: 'Usage: uifn preset encode|decode|resolve|url|open|tokens' } };
  } catch (cause) {
    if (cause instanceof UIFnPresetError) return { ok: false, error: { code: cause.code, message: cause.message, ...cause.details } };
    throw cause;
  }
}

export function runInitCommand(options: {
  flags: Record<string, string | boolean>;
  rootDir: string;
  dryRun: boolean;
}): ReturnType<typeof initProject> {
  const code = typeof options.flags.preset === 'string' ? options.flags.preset : '';
  if (!code) return { ok: false, dryRun: options.dryRun, written: [], unchanged: [], error: { code: 'UIFN_PRESET_USAGE', message: 'Usage: uifn init --preset <code> [--dir <path>] [--template react-vite] [--dry-run]' } };
  if (options.flags.dir !== undefined && (typeof options.flags.dir !== 'string' || !options.flags.dir.trim())) return { ok: false, dryRun: options.dryRun, written: [], unchanged: [], error: { code: 'UIFN_PRESET_USAGE', message: '--dir requires a path.' } };
  const rootDir = typeof options.flags.dir === 'string' ? path.resolve(options.rootDir, options.flags.dir) : options.rootDir;
  return initProject({
    rootDir,
    preset: code,
    template: typeof options.flags.template === 'string' ? options.flags.template as 'react-vite' : 'react-vite',
    dryRun: options.dryRun,
  });
}

export function runApplyCommand(options: {
  flags: Record<string, string | boolean>;
  rootDir: string;
  dryRun: boolean;
}): ReturnType<typeof applyPreset> {
  const code = typeof options.flags.preset === 'string' ? options.flags.preset : '';
  if (!code) return { ok: false, dryRun: options.dryRun, written: [], unchanged: [], error: { code: 'UIFN_PRESET_USAGE', message: 'Usage: uifn apply --preset <code> [--only theme,font] [--dry-run]' } };
  if (options.flags.only !== undefined && (typeof options.flags.only !== 'string' || !options.flags.only.trim() || options.flags.only.split(',').some(value => !value.trim()))) return { ok: false, dryRun: options.dryRun, written: [], unchanged: [], error: { code: 'UIFN_PRESET_USAGE', message: '--only requires theme and/or font.' } };
  const only = typeof options.flags.only === 'string' ? options.flags.only.split(',').map((value) => value.trim()).filter(Boolean) as PartialPresetDomain[] : undefined;
  return applyPreset({ rootDir: options.rootDir, preset: code, dryRun: options.dryRun, only });
}

export const PRESET_HELP = 'uifn commands: list, info, add, diff, update, validate, doctor, remove, init, apply, preset encode|decode|resolve|url|open|tokens';
