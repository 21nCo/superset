export {
  APPROVED_SUPPORT_MATRIX,
  PILOT_ARTIFACTS,
  PRESET_AXES,
  PRESET_AXIS_LABELS,
  PRESET_CODE_PREFIX,
  PRESET_CREATE_ORIGIN,
  PRESET_DEFAULTS,
  PRESET_FIELD_ORDER,
  PRESET_OWNER,
  PRESET_SCHEMA_VERSION,
  type ApprovedTemplate,
  type PartialPresetDomain,
  type PresetAxis,
  type UIFnPresetInput,
  type UIFnPresetV1,
} from './schema';
export { UIFnPresetError, type PresetErrorCode } from './errors';
export { decodePreset, encodePreset, normalizePreset, parsePresetJson, redactPreset } from './codec';
export { presetFromUrl, presetShareUrl } from './url';
export { hashSeed, randomPreset, type PresetLocks } from './random';
export { compilePreset, themeTokenDocument, type PresetCompilePlan } from './compiler';
export { pairwiseCoverageCount, pairwisePresets } from './pairwise';
export { fixtureCss } from './fixtures';

export { presetFixtureTree, PRESET_FIXTURE_COMPONENTS, type PresetFixtureNode } from './fixture-tree';
