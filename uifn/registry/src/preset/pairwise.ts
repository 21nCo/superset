import { PRESET_AXES, PRESET_DEFAULTS, PRESET_FIELD_ORDER, type PresetAxis, type UIFnPresetV1 } from './schema';
import { normalizePreset } from './codec';

function pairKey(leftAxis: string, leftValue: string, rightAxis: string, rightValue: string): string {
  return `${leftAxis}:${leftValue}|${rightAxis}:${rightValue}`;
}

export function pairwisePresets(): UIFnPresetV1[] {
  const uncovered = new Set<string>();
  for (let left = 0; left < PRESET_FIELD_ORDER.length; left += 1) {
    for (let right = left + 1; right < PRESET_FIELD_ORDER.length; right += 1) {
      const leftAxis = PRESET_FIELD_ORDER[left];
      const rightAxis = PRESET_FIELD_ORDER[right];
      for (const leftValue of PRESET_AXES[leftAxis]) {
        for (const rightValue of PRESET_AXES[rightAxis]) {
          uncovered.add(pairKey(leftAxis, leftValue, rightAxis, rightValue));
        }
      }
    }
  }

  const rows: UIFnPresetV1[] = [];
  while (uncovered.size > 0) {
    const seed = [...uncovered][0];
    const [leftPart, rightPart] = seed.split('|');
    const [leftAxis, leftValue] = leftPart.split(':') as [PresetAxis, string];
    const [rightAxis, rightValue] = rightPart.split(':') as [PresetAxis, string];
    const candidate = { ...PRESET_DEFAULTS, [leftAxis]: leftValue, [rightAxis]: rightValue } as UIFnPresetV1;
    const locked = new Set<PresetAxis>([leftAxis, rightAxis]);
    for (const axis of PRESET_FIELD_ORDER) {
      if (locked.has(axis)) continue;
      let best = candidate[axis];
      let bestScore = -1;
      for (const value of PRESET_AXES[axis]) {
        candidate[axis] = value as never;
        const score = countCovered(candidate, uncovered);
        if (score > bestScore) {
          best = value as never;
          bestScore = score;
        }
      }
      candidate[axis] = best as never;
    }
    const preset = normalizePreset(candidate);
    for (const pair of coveredPairs(preset)) uncovered.delete(pair);
    rows.push(preset);
  }
  return rows;
}

function coveredPairs(preset: UIFnPresetV1): string[] {
  const pairs: string[] = [];
  for (let left = 0; left < PRESET_FIELD_ORDER.length; left += 1) {
    for (let right = left + 1; right < PRESET_FIELD_ORDER.length; right += 1) {
      const leftAxis = PRESET_FIELD_ORDER[left];
      const rightAxis = PRESET_FIELD_ORDER[right];
      pairs.push(pairKey(leftAxis, preset[leftAxis], rightAxis, preset[rightAxis]));
    }
  }
  return pairs;
}

function countCovered(preset: UIFnPresetV1, uncovered: Set<string>): number {
  return coveredPairs(preset).reduce((total, pair) => total + (uncovered.has(pair) ? 1 : 0), 0);
}

export function pairwiseCoverageCount(): { combinations: number; pairs: number } {
  const rows = pairwisePresets();
  let pairs = 0;
  for (let left = 0; left < PRESET_FIELD_ORDER.length; left += 1) {
    for (let right = left + 1; right < PRESET_FIELD_ORDER.length; right += 1) {
      pairs += PRESET_AXES[PRESET_FIELD_ORDER[left]].length * PRESET_AXES[PRESET_FIELD_ORDER[right]].length;
    }
  }
  return { combinations: rows.length, pairs };
}
