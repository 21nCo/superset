export const PRESET_SCHEMA_VERSION = 1 as const;
export const PRESET_CODE_PREFIX = 'uifn1_';
export const PRESET_CREATE_ORIGIN = 'https://uifn.dev/create';
export const PRESET_OWNER = 'uifn-maintainer';

export const PRESET_AXES = {
  style: ['nova', 'meridian', 'atlas'],
  baseColor: ['zinc', 'slate', 'stone', 'neutral', 'gray', 'mauve'],
  theme: ['default', 'high-contrast'],
  chartColor: ['spectrum', 'earth', 'ocean', 'sunset'],
  font: ['inter', 'source-sans', 'ibm-plex-sans', 'literata'],
  headingFont: ['inherit', 'inter', 'source-serif', 'space-grotesk'],
  iconLibrary: ['lucide', 'phosphor', 'heroicons'],
  radius: ['none', 'sm', 'md', 'lg', 'xl'],
  density: ['compact', 'comfortable', 'spacious'],
  menuTreatment: ['inset', 'bordered', 'elevated'],
  framework: ['react', 'svelte', 'solid'],
  installMode: ['package', 'source'],
} as const;

export const PRESET_FIELD_ORDER = [
  'style',
  'baseColor',
  'theme',
  'chartColor',
  'font',
  'headingFont',
  'iconLibrary',
  'radius',
  'density',
  'menuTreatment',
  'framework',
  'installMode',
] as const;

export type PresetAxis = keyof typeof PRESET_AXES;
export type PresetAxisValue<K extends PresetAxis> = (typeof PRESET_AXES)[K][number];

export interface UIFnPresetV1 {
  version: 1;
  style: PresetAxisValue<'style'>;
  baseColor: PresetAxisValue<'baseColor'>;
  theme: PresetAxisValue<'theme'>;
  chartColor: PresetAxisValue<'chartColor'>;
  font: PresetAxisValue<'font'>;
  headingFont: PresetAxisValue<'headingFont'>;
  iconLibrary: PresetAxisValue<'iconLibrary'>;
  radius: PresetAxisValue<'radius'>;
  density: PresetAxisValue<'density'>;
  menuTreatment: PresetAxisValue<'menuTreatment'>;
  framework: PresetAxisValue<'framework'>;
  installMode: PresetAxisValue<'installMode'>;
}

export type UIFnPresetInput = Partial<Omit<UIFnPresetV1, 'version'>> & { version?: number };

export const PRESET_DEFAULTS: UIFnPresetV1 = {
  version: 1,
  style: 'nova',
  baseColor: 'zinc',
  theme: 'default',
  chartColor: 'spectrum',
  font: 'inter',
  headingFont: 'inherit',
  iconLibrary: 'lucide',
  radius: 'md',
  density: 'comfortable',
  menuTreatment: 'elevated',
  framework: 'react',
  installMode: 'package',
};

export const PRESET_AXIS_LABELS: Record<PresetAxis, string> = {
  style: 'Style family',
  baseColor: 'Base color',
  theme: 'Semantic theme',
  chartColor: 'Chart palette',
  font: 'Body font',
  headingFont: 'Heading font',
  iconLibrary: 'Icon library',
  radius: 'Radius',
  density: 'Density',
  menuTreatment: 'Menu treatment',
  framework: 'Framework',
  installMode: 'Install mode',
};

export const APPROVED_SUPPORT_MATRIX = {
  templates: ['react-vite'] as const,
  frameworks: ['react'] as const,
  packageManagers: ['npm'] as const,
  installModes: ['package', 'source'] as const,
  partialDomains: ['theme', 'font'] as const,
  encoding: 'self-contained' as const,
  compatibility: 'V1 codes remain decodable for the life of schema version 1. Unknown future versions fail closed.',
};

export type ApprovedTemplate = (typeof APPROVED_SUPPORT_MATRIX.templates)[number];
export type PartialPresetDomain = (typeof APPROVED_SUPPORT_MATRIX.partialDomains)[number];

export const PILOT_ARTIFACTS = [
  'button',
  'field',
  'input',
  'checkbox',
  'switch',
  'select',
  'dialog',
  'menu',
  'tabs',
  'card',
  'table',
] as const;
