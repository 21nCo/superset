import { PRESET_CODE_PREFIX, PRESET_CREATE_ORIGIN } from './schema';
import { decodePreset, encodePreset } from './codec';
import type { UIFnPresetInput, UIFnPresetV1 } from './schema';
import { UIFnPresetError } from './errors';

export function presetShareUrl(input: UIFnPresetInput | UIFnPresetV1 | string, origin = PRESET_CREATE_ORIGIN): string {
  const code = typeof input === 'string' ? encodePreset(decodePreset(input)) : encodePreset(input);
  const url = new URL(origin);
  url.search = '';
  url.searchParams.set('preset', code);
  return url.toString();
}

export function presetFromUrl(value: string): UIFnPresetV1 {
  if (value.startsWith('#preset=')) return decodePreset(value.slice('#preset='.length));
  try {
    const url = new URL(value);
    const code = url.searchParams.get('preset') ?? url.searchParams.get('p') ?? url.hash.replace(/^#preset=/, '');
    if (!code) throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Share URL is missing a preset code.');
    return decodePreset(code);
  } catch (cause) {
    if (cause instanceof UIFnPresetError) throw cause;
    if (value.startsWith(PRESET_CODE_PREFIX)) return decodePreset(value);
    throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Share URL could not be parsed.');
  }
}
