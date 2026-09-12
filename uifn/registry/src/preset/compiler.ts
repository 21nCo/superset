import { encodePreset } from './codec';
import { APPROVED_SUPPORT_MATRIX, PILOT_ARTIFACTS, type ApprovedTemplate, type UIFnPresetV1 } from './schema';
import { UIFnPresetError } from './errors';
import { presetShareUrl } from './url';

export interface FontSpec {
  id: string;
  family: string;
  fallback: string;
  cssStack: string;
  stylesheet?: string;
  license: string;
}

export interface IconSpec {
  id: string;
  packageName: string;
  license: string;
}

export interface PresetCompilePlan {
  schemaVersion: 1;
  preset: UIFnPresetV1;
  code: string;
  url: string;
  template: ApprovedTemplate;
  theme: {
    lightName: string;
    darkName: string;
    accent: string;
    radius: Record<'sm' | 'md' | 'lg' | 'xl' | 'full', string>;
    densityScale: number;
    chartPalette: string[];
    lightVars: Record<string, string>;
    darkVars: Record<string, string>;
  };
  fonts: { body: FontSpec; heading: FontSpec };
  icons: IconSpec;
  menu: { treatment: UIFnPresetV1['menuTreatment'] };
  style: { family: UIFnPresetV1['style'] };
  project: {
    framework: UIFnPresetV1['framework'];
    installMode: UIFnPresetV1['installMode'];
    artifacts: string[];
    packages: Array<{ name: string; version: string; relationship: 'runtime' | 'peer' }>;
  };
  commands: {
    init: string;
    apply: string;
    applyTheme: string;
    applyFont: string;
    decode: string;
  };
  css: { light: string; dark: string; fonts: string };
}

const BASE_HUES: Record<UIFnPresetV1['baseColor'], number> = {
  zinc: 250,
  slate: 248,
  stone: 75,
  neutral: 0,
  gray: 255,
  mauve: 310,
};

const BASE_CHROMA: Record<UIFnPresetV1['baseColor'], number> = {
  zinc: 0.02,
  slate: 0.028,
  stone: 0.016,
  neutral: 0.008,
  gray: 0.01,
  mauve: 0.04,
};

const STYLE_SHIFT: Record<UIFnPresetV1['style'], { hue: number; chroma: number; radius: number }> = {
  nova: { hue: 0, chroma: 0.02, radius: 0 },
  meridian: { hue: 12, chroma: 0.01, radius: 2 },
  atlas: { hue: -8, chroma: -0.01, radius: -2 },
};

const RADIUS_BASE: Record<UIFnPresetV1['radius'], Record<'sm' | 'md' | 'lg' | 'xl', number>> = {
  none: { sm: 0, md: 0, lg: 0, xl: 0 },
  sm: { sm: 2, md: 4, lg: 6, xl: 8 },
  md: { sm: 4, md: 6, lg: 8, xl: 12 },
  lg: { sm: 6, md: 10, lg: 14, xl: 20 },
  xl: { sm: 10, md: 16, lg: 24, xl: 32 },
};

const DENSITY_SCALE: Record<UIFnPresetV1['density'], number> = {
  compact: 0.875,
  comfortable: 1,
  spacious: 1.125,
};

const FONTS: Record<UIFnPresetV1['font'] | 'source-serif' | 'space-grotesk', FontSpec> = {
  inter: {
    id: 'inter',
    family: 'Inter',
    fallback: 'ui-sans-serif, system-ui, sans-serif',
    cssStack: 'Inter, ui-sans-serif, system-ui, sans-serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;650;700&display=swap',
    license: 'OFL-1.1',
  },
  'source-sans': {
    id: 'source-sans',
    family: 'Source Sans 3',
    fallback: 'ui-sans-serif, system-ui, sans-serif',
    cssStack: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;650;700&display=swap',
    license: 'OFL-1.1',
  },
  'ibm-plex-sans': {
    id: 'ibm-plex-sans',
    family: 'IBM Plex Sans',
    fallback: 'ui-sans-serif, system-ui, sans-serif',
    cssStack: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;650;700&display=swap',
    license: 'OFL-1.1',
  },
  literata: {
    id: 'literata',
    family: 'Literata',
    fallback: 'ui-serif, Georgia, serif',
    cssStack: 'Literata, ui-serif, Georgia, serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,600;7..72,700&display=swap',
    license: 'OFL-1.1',
  },
  'source-serif': {
    id: 'source-serif',
    family: 'Source Serif 4',
    fallback: 'ui-serif, Georgia, serif',
    cssStack: '"Source Serif 4", ui-serif, Georgia, serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap',
    license: 'OFL-1.1',
  },
  'space-grotesk': {
    id: 'space-grotesk',
    family: 'Space Grotesk',
    fallback: 'ui-sans-serif, system-ui, sans-serif',
    cssStack: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    stylesheet: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap',
    license: 'OFL-1.1',
  },
};

const ICONS: Record<UIFnPresetV1['iconLibrary'], IconSpec> = {
  lucide: { id: 'lucide', packageName: 'lucide-react', license: 'MIT' },
  phosphor: { id: 'phosphor', packageName: '@phosphor-icons/react', license: 'MIT' },
  heroicons: { id: 'heroicons', packageName: '@heroicons/react', license: 'MIT' },
};

const CHARTS: Record<UIFnPresetV1['chartColor'], string[]> = {
  spectrum: ['oklch(62% 0.18 250)', 'oklch(64% 0.16 145)', 'oklch(66% 0.16 80)', 'oklch(58% 0.19 25)', 'oklch(60% 0.16 310)'],
  earth: ['oklch(58% 0.08 75)', 'oklch(52% 0.1 145)', 'oklch(62% 0.12 80)', 'oklch(48% 0.06 50)', 'oklch(70% 0.08 90)'],
  ocean: ['oklch(55% 0.14 230)', 'oklch(62% 0.1 200)', 'oklch(48% 0.08 250)', 'oklch(70% 0.06 190)', 'oklch(42% 0.1 260)'],
  sunset: ['oklch(62% 0.18 25)', 'oklch(66% 0.16 50)', 'oklch(58% 0.16 350)', 'oklch(70% 0.12 80)', 'oklch(48% 0.14 20)'],
};

function oklch(l: number, c: number, h: number): string {
  return `oklch(${Math.round(l * 1000) / 10}% ${Math.max(0, Math.round(c * 1000) / 1000)} ${Math.round(((h % 360) + 360) % 360)})`;
}

function px(value: number): string {
  return `${Math.max(0, value)}px`;
}

function linearRgb(lightness: number, chroma: number, hue: number): number[] {
  const angle = hue * Math.PI / 180;
  const a = chroma * Math.cos(angle), b = chroma * Math.sin(angle);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
    -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
    -0.0041960863*l - 0.7034186147*m + 1.707614701*s];
}

// Reduce chroma at fixed OKLCH lightness/hue, then emit that exact sRGB color.
// Foreground contrast therefore uses the rendered color, without depending on
// a browser's out-of-gamut mapping algorithm.
function mappedRgb(lightness: number, chroma: number, hue: number): number[] {
  let low = 0, high = chroma;
  const inGamut = (rgb: number[]) => rgb.every(value => value >= 0 && value <= 1);
  if (inGamut(linearRgb(lightness, chroma, hue))) return linearRgb(lightness, chroma, hue);
  for (let step = 0; step < 24; step++) {
    const mid = (low + high) / 2;
    if (inGamut(linearRgb(lightness, mid, hue))) low = mid; else high = mid;
  }
  return linearRgb(lightness, low, hue).map(value => Math.max(0, Math.min(1, value)));
}

function solidColor(lightness: number, chroma: number, hue: number): string {
  const encoded = mappedRgb(lightness, chroma, hue).map(value =>
    ((value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255).toFixed(6));
  return `rgb(${encoded.join(' ')})`;
}

function contrastOn(lightness: number, chroma: number, hue: number): string {
  const [r, g, b] = mappedRgb(lightness, chroma, hue);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

function colorVars(preset: UIFnPresetV1, mode: 'light' | 'dark'): Record<string, string> {
  const shift = STYLE_SHIFT[preset.style];
  const hue = BASE_HUES[preset.baseColor] + shift.hue;
  const chroma = Math.max(0.004, BASE_CHROMA[preset.baseColor] + shift.chroma);
  const high = preset.theme === 'high-contrast';
  const accentHue = hue;
  const accentChroma = high ? Math.max(chroma, 0.16) : 0.18 + shift.chroma;
  const textPrimary = mode === 'dark' ? oklch(high ? 0.98 : 0.95, Math.min(chroma, 0.012), hue) : oklch(high ? 0.12 : 0.2, Math.min(chroma, 0.024), hue);
  const canvas = mode === 'dark' ? oklch(high ? 0.08 : 0.15, Math.min(chroma, 0.02), hue) : oklch(high ? 1 : 0.98, Math.min(chroma, 0.014), hue);
  const accentSolid = solidColor(mode === 'dark' ? (high ? 0.78 : 0.68) : (high ? 0.46 : 0.55), accentChroma, accentHue);
  const radius = RADIUS_BASE[preset.radius];
  const radiusShift = shift.radius;
  return {
    '--uifn-color-surface-canvas': canvas,
    '--uifn-color-surface-raised': mode === 'dark' ? oklch(high ? 0.12 : 0.2, Math.min(chroma, 0.022), hue) : oklch(1, Math.min(chroma, 0.008), hue),
    '--uifn-color-surface-sunken': mode === 'dark' ? oklch(high ? 0.05 : 0.11, Math.min(chroma, 0.018), hue) : oklch(high ? 0.92 : 0.94, Math.min(chroma, 0.016), hue),
    '--uifn-color-surface-overlay': mode === 'dark' ? oklch(high ? 0.16 : 0.24, Math.min(chroma, 0.024), hue) : oklch(0.99, Math.min(chroma, 0.01), hue),
    '--uifn-color-surface-depth-0': canvas,
    '--uifn-color-surface-depth-1': mode === 'dark' ? oklch(0.18, Math.min(chroma, 0.022), hue) : oklch(0.96, Math.min(chroma, 0.016), hue),
    '--uifn-color-surface-depth-2': mode === 'dark' ? oklch(0.21, Math.min(chroma, 0.024), hue) : oklch(0.94, Math.min(chroma, 0.018), hue),
    '--uifn-color-surface-depth-3': mode === 'dark' ? oklch(0.24, Math.min(chroma, 0.026), hue) : oklch(0.92, Math.min(chroma, 0.02), hue),
    '--uifn-color-surface-depth-4': mode === 'dark' ? oklch(0.27, Math.min(chroma, 0.028), hue) : oklch(0.9, Math.min(chroma, 0.022), hue),
    '--uifn-color-text-primary': textPrimary,
    '--uifn-color-text-secondary': mode === 'dark' ? oklch(0.82, Math.min(chroma, 0.014), hue) : oklch(0.35, Math.min(chroma, 0.024), hue),
    '--uifn-color-text-muted': mode === 'dark' ? oklch(0.7, Math.min(chroma, 0.014), hue) : oklch(0.5, Math.min(chroma, 0.018), hue),
    '--uifn-color-text-disabled': mode === 'dark' ? oklch(0.54, Math.min(chroma, 0.012), hue) : oklch(0.55, Math.min(chroma, 0.012), hue),
    '--uifn-color-border-subtle': mode === 'dark' ? oklch(high ? 0.4 : 0.28, Math.min(chroma, 0.018), hue) : oklch(high ? 0.72 : 0.88, Math.min(chroma, 0.012), hue),
    '--uifn-color-border-default': mode === 'dark' ? oklch(high ? 0.52 : 0.38, Math.min(chroma, 0.02), hue) : oklch(high ? 0.58 : 0.78, Math.min(chroma, 0.014), hue),
    '--uifn-color-border-strong': mode === 'dark' ? oklch(0.54, Math.min(chroma, 0.022), hue) : oklch(0.58, Math.min(chroma, 0.016), hue),
    '--uifn-color-accent-solid': accentSolid,
    '--uifn-color-accent-subtle': mode === 'dark' ? oklch(0.24, 0.05, accentHue) : oklch(0.93, 0.05, accentHue),
    '--uifn-color-accent-contrast': contrastOn(mode === 'dark' ? (high ? 0.78 : 0.68) : (high ? 0.46 : 0.55), accentChroma, accentHue),
    '--uifn-color-danger-solid': solidColor(mode === 'dark' ? 0.68 : 0.5, 0.19, 25),
    '--uifn-color-danger-subtle': mode === 'dark' ? 'oklch(24% 0.05 25)' : 'oklch(94% 0.04 25)',
    '--uifn-color-danger-contrast': contrastOn(mode === 'dark' ? 0.68 : 0.5, 0.19, 25),
    '--uifn-color-warning-solid': solidColor(mode === 'dark' ? 0.76 : 0.64, 0.16, 80),
    '--uifn-color-warning-subtle': mode === 'dark' ? 'oklch(24% 0.06 80)' : 'oklch(94% 0.05 80)',
    '--uifn-color-warning-contrast': contrastOn(mode === 'dark' ? 0.76 : 0.64, 0.16, 80),
    '--uifn-color-success-solid': solidColor(mode === 'dark' ? 0.68 : 0.48, 0.14, 145),
    '--uifn-color-success-subtle': mode === 'dark' ? 'oklch(24% 0.05 145)' : 'oklch(93% 0.04 145)',
    '--uifn-color-success-contrast': contrastOn(mode === 'dark' ? 0.68 : 0.48, 0.14, 145),
    '--uifn-radius-sm': px(Math.max(0, radius.sm + radiusShift)),
    '--uifn-radius-md': px(Math.max(0, radius.md + radiusShift)),
    '--uifn-radius-lg': px(Math.max(0, radius.lg + radiusShift)),
    '--uifn-radius-xl': px(Math.max(0, radius.xl + radiusShift)),
    '--uifn-radius-full': '9999px',
    '--uifn-density-compact': '0.875',
    '--uifn-density-comfortable': '1',
    '--uifn-density-spacious': '1.125',
    ...Object.fromEntries(CHARTS[preset.chartColor].map((color, index) => [`--uifn-chart-${index + 1}`, color])),
    '--uifn-density-scale': String(DENSITY_SCALE[preset.density]),
    '--uifn-typography-family-sans': fontSpec(preset).body.cssStack,
    '--uifn-typography-family-heading': fontSpec(preset).heading.cssStack,
    '--uifn-control-size-sm': `${2 * DENSITY_SCALE[preset.density]}rem`,
    '--uifn-control-size-md': `${2.5 * DENSITY_SCALE[preset.density]}rem`,
    '--uifn-control-size-lg': `${3 * DENSITY_SCALE[preset.density]}rem`,
  };
}

function fontSpec(preset: UIFnPresetV1): { body: FontSpec; heading: FontSpec } {
  const body = FONTS[preset.font];
  const heading = preset.headingFont === 'inherit' ? body : FONTS[preset.headingFont];
  return { body, heading };
}

function cssFromVars(vars: Record<string, string>, selector: string): string {
  const declarations = Object.entries(vars).map(([name, value]) => `${name}:${value};`).join('');
  return `${selector}{${declarations}}`;
}

function menuCss(preset: UIFnPresetV1, scope: string): string {
  const shadow = { elevated: '0 18px 48px rgb(15 23 42 / 16%)', inset: 'inset 0 1px 3px rgb(15 23 42 / 12%)', bordered: 'none' }[preset.menuTreatment];
  return `${scope}[data-uifn-component="menu"][data-uifn-part="content"]{--uifn-component-shadow:${shadow};}`;
}

function frameworkPackages(preset: UIFnPresetV1): Array<{ name: string; version: string; relationship: 'runtime' | 'peer' }> {
  if (preset.framework === 'svelte') {
    return [
      { name: '@uifn/components-svelte', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/svelte', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/recipes', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/theme', version: '0.0.1', relationship: 'runtime' },
      { name: 'svelte', version: '5.46.4', relationship: 'peer' },
    ];
  }
  if (preset.framework === 'solid') {
    return [
      { name: '@uifn/components-solid', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/solid', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/recipes', version: '0.0.1', relationship: 'runtime' },
      { name: '@uifn/theme', version: '0.0.1', relationship: 'runtime' },
      { name: 'solid-js', version: '1.9.13', relationship: 'peer' },
    ];
  }
  return [
    ...(preset.installMode === 'package' ? [{ name: '@uifn/components-react', version: '0.0.1', relationship: 'runtime' as const }] : []),
    { name: '@uifn/components', version: '0.0.1', relationship: 'runtime' },
    { name: '@uifn/react', version: '0.0.3', relationship: 'runtime' },
    { name: '@uifn/recipes', version: '0.0.1', relationship: 'runtime' },
    { name: '@uifn/theme', version: '0.0.1', relationship: 'runtime' },
    { name: 'react', version: '18.3.1', relationship: 'peer' },
    { name: 'react-dom', version: '18.3.1', relationship: 'peer' },
  ];
}

export function assertApprovedInit(preset: UIFnPresetV1, template: ApprovedTemplate = 'react-vite'): void {
  if (!APPROVED_SUPPORT_MATRIX.templates.includes(template)) {
    throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_COMBINATION', `Unsupported project template: ${template}.`, {
      template,
      approved: APPROVED_SUPPORT_MATRIX.templates,
    });
  }
  if (!APPROVED_SUPPORT_MATRIX.frameworks.includes(preset.framework as (typeof APPROVED_SUPPORT_MATRIX.frameworks)[number])) {
    throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_COMBINATION', `V1 init/apply supports react-vite only. Requested framework: ${preset.framework}.`, {
      framework: preset.framework,
      approved: APPROVED_SUPPORT_MATRIX.frameworks,
    });
  }
}

export function compilePreset(preset: UIFnPresetV1, template: ApprovedTemplate = 'react-vite'): PresetCompilePlan {
  const code = encodePreset(preset);
  const fonts = fontSpec(preset);
  const lightVars = colorVars(preset, 'light');
  const darkVars = colorVars(preset, 'dark');
  const radius = RADIUS_BASE[preset.radius];
  const radiusShift = STYLE_SHIFT[preset.style].radius;
  const stylesheets = [...new Set([fonts.body.stylesheet, fonts.heading.stylesheet].filter(Boolean))] as string[];
  return {
    schemaVersion: 1,
    preset,
    code,
    url: presetShareUrl(code),
    template,
    theme: {
      lightName: preset.theme === 'high-contrast' ? 'uifn-high-contrast-light' : 'uifn-light',
      darkName: preset.theme === 'high-contrast' ? 'uifn-high-contrast-dark' : 'uifn-dark',
      accent: lightVars['--uifn-color-accent-solid'],
      radius: {
        sm: px(Math.max(0, radius.sm + radiusShift)),
        md: px(Math.max(0, radius.md + radiusShift)),
        lg: px(Math.max(0, radius.lg + radiusShift)),
        xl: px(Math.max(0, radius.xl + radiusShift)),
        full: '9999px',
      },
      densityScale: DENSITY_SCALE[preset.density],
      chartPalette: CHARTS[preset.chartColor],
      lightVars,
      darkVars,
    },
    fonts,
    icons: ICONS[preset.iconLibrary],
    menu: { treatment: preset.menuTreatment },
    style: { family: preset.style },
    project: {
      framework: preset.framework,
      installMode: preset.installMode,
      artifacts: [...PILOT_ARTIFACTS],
      packages: [...frameworkPackages(preset), ...(preset.framework === 'react' ? [{ name: ICONS[preset.iconLibrary].packageName, version: { lucide: '0.575.0', phosphor: '2.1.10', heroicons: '2.2.0' }[preset.iconLibrary], relationship: 'runtime' as const }] : [])],
    },
    commands: {
      init: `uifn init --preset ${code} --template ${template}`,
      apply: `uifn apply --preset ${code}`,
      applyTheme: `uifn apply --preset ${code} --only theme`,
      applyFont: `uifn apply --preset ${code} --only font`,
      decode: `uifn preset decode ${code}`,
    },
    css: {
      light: cssFromVars(lightVars, ':root') + menuCss(preset, ''),
      dark: cssFromVars(darkVars, ':root[data-uifn-mode="dark"]') + menuCss(preset, ':root[data-uifn-mode="dark"] '),
      fonts: stylesheets.map((href) => `@import url('${href}');`).join('\n'),
    },
  };
}

export function themeTokenDocument(preset: UIFnPresetV1): { light: Record<string, string>; dark: Record<string, string> } {
  return {
    light: compilePreset(preset).theme.lightVars,
    dark: compilePreset(preset).theme.darkVars,
  };
}
