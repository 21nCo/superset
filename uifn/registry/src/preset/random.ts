import { PRESET_AXES, PRESET_DEFAULTS, type PresetAxis, type UIFnPresetV1 } from './schema';
import { normalizePreset } from './codec';

export type PresetLocks = Partial<Record<PresetAxis, boolean>>;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function randomPreset(options: { seed?: number | string; locks?: PresetLocks; base?: Partial<UIFnPresetV1> } = {}): UIFnPresetV1 {
  const current = normalizePreset(options.base ?? PRESET_DEFAULTS);
  const random = mulberry32(typeof options.seed === 'string' ? hashSeed(options.seed) : options.seed ?? Date.now() >>> 0);
  const next: UIFnPresetV1 = { ...current };
  for (const axis of Object.keys(PRESET_AXES) as PresetAxis[]) {
    if (options.locks?.[axis]) continue;
    const values = PRESET_AXES[axis];
    next[axis] = values[Math.floor(random() * values.length)] as never;
  }
  return normalizePreset(next);
}
