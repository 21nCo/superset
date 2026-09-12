import { describe, expect, it } from 'vitest';
import {
  APPROVED_SUPPORT_MATRIX,
  PRESET_AXES,
  PRESET_DEFAULTS,
  PRESET_FIELD_ORDER,
  compilePreset,
  decodePreset,
  encodePreset,
  normalizePreset,
  pairwisePresets,
  presetFromUrl,
  presetShareUrl,
  randomPreset,
} from '../preset';
import { UIFnPresetError } from '../preset/errors';

describe('UIFnPresetV1 contract', () => {
  it('fills defaults and encodes deterministically', () => {
    const left = encodePreset({});
    const right = encodePreset({ ...PRESET_DEFAULTS });
    expect(left).toBe(right);
    expect(left.startsWith('uifn1_')).toBe(true);
    expect(decodePreset(left)).toEqual(PRESET_DEFAULTS);
  });

  it('round-trips every axis value', () => {
    for (const field of PRESET_FIELD_ORDER) {
      for (const value of PRESET_AXES[field]) {
        const preset = normalizePreset({ [field]: value });
        expect(decodePreset(encodePreset(preset))[field]).toBe(value);
      }
    }
  });

  it('round-trips through share URLs', () => {
    const preset = normalizePreset({ style: 'atlas', baseColor: 'mauve', density: 'compact' });
    const url = presetShareUrl(preset);
    expect(url.startsWith('https://uifn.dev/create?preset=uifn1_')).toBe(true);
    expect(presetFromUrl(url)).toEqual(preset);
    expect(presetFromUrl(encodePreset(preset))).toEqual(preset);
  });

  it('rejects unknown fields, options, and future versions', () => {
    expect(() => normalizePreset({ version: 2 } as never)).toThrow(UIFnPresetError);
    expect(() => normalizePreset({ style: 'shadcn' } as never)).toThrow(/style/);
    expect(() => normalizePreset({ extra: 'nope' } as never)).toThrow(/Unknown preset field/);
    expect(() => decodePreset('uifn2_aaaa')).toThrow(/version prefix|integrity|unsupported/i);
    const payload = encodePreset(PRESET_DEFAULTS);
    const flipped = `${payload.slice(0, 10)}${payload[10] === 'A' ? 'B' : 'A'}${payload.slice(11)}`;
    expect(() => decodePreset(flipped)).toThrow(UIFnPresetError);
  });

  it('randomizes unlocked axes only', () => {
    const preset = randomPreset({ seed: 21, locks: { framework: true, installMode: true }, base: PRESET_DEFAULTS });
    expect(preset.framework).toBe('react');
    expect(preset.installMode).toBe('package');
    expect(PRESET_FIELD_ORDER.some(axis => !['framework', 'installMode'].includes(axis) && preset[axis] !== PRESET_DEFAULTS[axis])).toBe(true);
    expect(encodePreset(randomPreset({ seed: 21 }))).toBe(encodePreset(randomPreset({ seed: 21 })));
  });

  it('compiles commands, fonts, and public CSS variables from the same preset', () => {
    const preset = normalizePreset({ style: 'meridian', radius: 'xl', font: 'literata', headingFont: 'space-grotesk' });
    const plan = compilePreset(preset);
    expect(plan.code).toBe(encodePreset(preset));
    expect(plan.commands.init).toContain(plan.code);
    expect(plan.css.light).toContain('--uifn-color-accent-solid:');
    expect(plan.css.dark).toContain(':root[data-uifn-mode="dark"]');
    expect(plan.fonts.body.family).toBe('Literata');
    expect(plan.fonts.heading.family).toBe('Space Grotesk');
    expect(plan.theme.lightVars['--uifn-typography-family-sans']).toContain('Literata');
  });

  it('documents the approved V1 matrix and pairwise coverage', () => {
    expect(APPROVED_SUPPORT_MATRIX).toMatchObject({ templates: ['react-vite'], frameworks: ['react'], encoding: 'self-contained' });
    const rows = pairwisePresets();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(200);
    const styles = new Set(rows.map((row) => row.style));
    expect(styles.size).toBe(PRESET_AXES.style.length);
  });
  it('rejects noncanonical codes and malformed JSON roots', () => {
    const code = encodePreset({});
    expect(() => decodePreset(code + 'A')).toThrow();
    for (const input of [null, [], 'wrong', 12, { version: null }]) expect(() => normalizePreset(input as never)).toThrow();
    expect(() => decodePreset('uifn2_aaaa')).toThrow(expect.objectContaining({ code: 'UIFN_PRESET_UNSUPPORTED_VERSION' }));
    expect(presetFromUrl('#preset=' + code)).toEqual(PRESET_DEFAULTS);
  });

});

it('computes contrast from the emitted in-gamut sRGB solid', () => {
  for (const baseColor of PRESET_AXES.baseColor) {
    const plan = compilePreset(normalizePreset({ style: 'atlas', baseColor }));
    for (const vars of [plan.theme.lightVars, plan.theme.darkVars]) {
      for (const kind of ['accent', 'danger', 'warning', 'success']) {
        const channels = vars[`--uifn-color-${kind}-solid`].match(/[0-9.]+/g)!.map(Number);
        expect(channels.every(value => value >= 0 && value <= 255)).toBe(true);
        const [r,g,b] = channels.map(value => { const s = value/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4; });
        const luminance = .2126*r+.7152*g+.0722*b;
        const black = (luminance+.05)/.05, white = 1.05/(luminance+.05);
        expect(vars[`--uifn-color-${kind}-contrast`]).toBe(black >= white ? '#000000' : '#ffffff');
        expect(Math.max(black, white)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

it.each(['lucide', 'phosphor', 'heroicons'] as const)('includes the selected %s icon dependency', iconLibrary => {
  const plan = compilePreset(normalizePreset({ iconLibrary }));
  expect(plan.project.packages.some(item => item.name === plan.icons.packageName && item.relationship === 'runtime')).toBe(true);
});
it('scopes every menu treatment to menus without changing dialog shadows', () => {
  const css = (['elevated', 'inset', 'bordered'] as const).map(menuTreatment => compilePreset(normalizePreset({ menuTreatment })).css.light);
  expect(new Set(css).size).toBe(3);
  for (const text of css) {
    expect(text).toContain('[data-uifn-component="menu"][data-uifn-part="content"]{--uifn-component-shadow:');
    expect(text).not.toContain('--uifn-component-shadow-overlay:');
  }
});
