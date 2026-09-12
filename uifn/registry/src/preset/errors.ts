export type PresetErrorCode =
  | 'UIFN_PRESET_UNSUPPORTED_VERSION'
  | 'UIFN_PRESET_CODE_INVALID'
  | 'UIFN_PRESET_UNKNOWN_FIELD'
  | 'UIFN_PRESET_UNKNOWN_OPTION'
  | 'UIFN_PRESET_INVALID_JSON'
  | 'UIFN_PRESET_UNSUPPORTED_COMBINATION'
  | 'UIFN_PRESET_PROJECT_MISSING'
  | 'UIFN_PRESET_PROJECT_AMBIGUOUS'
  | 'UIFN_PRESET_RESOLVE_DEVIATION'
  | 'UIFN_PRESET_OPEN_FAILED'
  | 'UIFN_PRESET_OPEN_UNKNOWN'
  | 'UIFN_PRESET_USAGE';

export class UIFnPresetError extends Error {
  readonly name = 'UIFnPresetError';
  readonly code: PresetErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PresetErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.details = details;
  }
}

export function presetFailure(code: PresetErrorCode, message: string, details?: Record<string, unknown>) {
  return { ok: false as const, error: { code, message, ...details } };
}
