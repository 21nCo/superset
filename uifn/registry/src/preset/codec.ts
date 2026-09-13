import {
  PRESET_AXES,
  PRESET_CODE_PREFIX,
  PRESET_DEFAULTS,
  PRESET_FIELD_ORDER,
  PRESET_SCHEMA_VERSION,
  type PresetAxis,
  type UIFnPresetInput,
  type UIFnPresetV1,
} from './schema';
import { UIFnPresetError } from './errors';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function toBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += BASE64URL[first >> 2];
    output += BASE64URL[((first & 3) << 4) | (second >> 4)];
    if (index + 1 < bytes.length) output += BASE64URL[((second & 15) << 2) | (third >> 6)];
    if (index + 2 < bytes.length) output += BASE64URL[third & 63];
  }
  return output;
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length < 4) {
    throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Preset code is not URL-safe base64.');
  }
  const codes = [...value].map((character) => {
    const code = BASE64URL.indexOf(character);
    if (code < 0) throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Preset code contains an invalid character.');
    return code;
  });
  const bytes: number[] = [];
  for (let index = 0; index < codes.length; index += 4) {
    const chunk = [codes[index], codes[index + 1] ?? 0, codes[index + 2] ?? 0, codes[index + 3] ?? 0];
    bytes.push(((chunk[0] << 2) | (chunk[1] >> 4)) & 0xff);
    if (index + 2 < codes.length) bytes.push(((chunk[1] << 4) | (chunk[2] >> 2)) & 0xff);
    if (index + 3 < codes.length) bytes.push(((chunk[2] << 6) | chunk[3]) & 0xff);
  }
  return Uint8Array.from(bytes);
}

function assertAxisValue<K extends PresetAxis>(axis: K, value: unknown): (typeof PRESET_AXES)[K][number] {
  const allowed = PRESET_AXES[axis] as readonly string[];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new UIFnPresetError('UIFN_PRESET_UNKNOWN_OPTION', `Unsupported ${axis} option: ${String(value)}.`, {
      axis,
      value,
      allowed,
    });
  }
  return value as (typeof PRESET_AXES)[K][number];
}

export function normalizePreset(input: UIFnPresetInput | UIFnPresetV1 = {}): UIFnPresetV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UIFnPresetError('UIFN_PRESET_INVALID_JSON', 'Preset must be an object.');
  {
    for (const key of Object.keys(input)) {
      if (key === 'version') continue;
      if (!PRESET_FIELD_ORDER.includes(key as PresetAxis)) {
        throw new UIFnPresetError('UIFN_PRESET_UNKNOWN_FIELD', `Unknown preset field: ${key}.`, { field: key });
      }
    }
  }
  const version = input.version === undefined ? PRESET_SCHEMA_VERSION : input.version;
  if (version !== PRESET_SCHEMA_VERSION) {
    throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_VERSION', `Unsupported preset schema version: ${version}.`, {
      version,
      supported: [PRESET_SCHEMA_VERSION],
    });
  }
  const next = { ...PRESET_DEFAULTS };
  for (const field of PRESET_FIELD_ORDER) {
    const value = input[field];
    if (value !== undefined) next[field] = assertAxisValue(field, value) as never;
  }
  next.version = PRESET_SCHEMA_VERSION;
  return next;
}

export function encodePreset(input: UIFnPresetInput | UIFnPresetV1 = {}): string {
  const preset = normalizePreset(input);
  const payload = Uint8Array.from([
    PRESET_SCHEMA_VERSION,
    ...PRESET_FIELD_ORDER.map((field) => (PRESET_AXES[field] as readonly string[]).indexOf(preset[field])),
  ]);
  const framed = Uint8Array.from([...payload, crc8(payload)]);
  return `${PRESET_CODE_PREFIX}${toBase64Url(framed)}`;
}

export function decodePreset(code: string): UIFnPresetV1 {
  const prefix = typeof code === 'string' ? /^uifn(\d+)_/.exec(code) : null;
  if (prefix && prefix[1] !== '1') throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_VERSION', `Unsupported preset code version: ${prefix[1]}.`);
  if (typeof code !== 'string' || !code.startsWith(PRESET_CODE_PREFIX)) {
    throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Preset code is missing the uifn1_ version prefix.');
  }
  const bytes = fromBase64Url(code.slice(PRESET_CODE_PREFIX.length));
  if (bytes.length !== PRESET_FIELD_ORDER.length + 2 || toBase64Url(bytes) !== code.slice(PRESET_CODE_PREFIX.length)) {
    throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Preset code has invalid framing or noncanonical base64.');
  }
  const payload = bytes.slice(0, PRESET_FIELD_ORDER.length + 1);
  const checksum = bytes[payload.length];
  if (checksum !== crc8(payload)) {
    throw new UIFnPresetError('UIFN_PRESET_CODE_INVALID', 'Preset code failed integrity checks.');
  }
  const version = payload[0];
  if (version !== PRESET_SCHEMA_VERSION) {
    throw new UIFnPresetError('UIFN_PRESET_UNSUPPORTED_VERSION', `Unsupported preset schema version: ${version}.`, {
      version,
      supported: [PRESET_SCHEMA_VERSION],
    });
  }
  const input: UIFnPresetInput = { version: PRESET_SCHEMA_VERSION };
  PRESET_FIELD_ORDER.forEach((field, index) => {
    const options = PRESET_AXES[field] as readonly string[];
    const optionIndex = payload[index + 1];
    if (optionIndex >= options.length) {
      throw new UIFnPresetError('UIFN_PRESET_UNKNOWN_OPTION', `Preset code references an unknown ${field} option.`, {
        axis: field,
        index: optionIndex,
      });
    }
    input[field] = options[optionIndex] as never;
  });
  return normalizePreset(input);
}

export function parsePresetJson(source: string): UIFnPresetV1 {
  try {
    return normalizePreset(JSON.parse(source) as UIFnPresetInput);
  } catch (cause) {
    if (cause instanceof UIFnPresetError) throw cause;
    throw new UIFnPresetError('UIFN_PRESET_INVALID_JSON', 'Preset JSON could not be parsed.');
  }
}

export function redactPreset(preset: UIFnPresetV1): UIFnPresetV1 {
  return { ...normalizePreset(preset) };
}
