// Settings (SPEC.md, Screens: Settings). They are stored as one object under
// the `settings` key of the `meta` store. A value that is missing there, or
// isn't a usable number, takes its default, so adding a setting later needs
// no database migration.

import { DEFAULT_ROLLOVER_HOUR } from './day.ts';

export interface Settings {
  /** The local hour a study day rolls over at. */
  rolloverHour: number;
  /** The daily goal, in minutes. */
  goalMin: number;
  /** A ceiling on new cards per study day. */
  maxNew: number;
  /** How far ahead learning cards are shown when nothing else is due, in minutes. */
  learnAheadMin: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  rolloverHour: DEFAULT_ROLLOVER_HOUR,
  goalMin: 20,
  maxNew: 25,
  learnAheadMin: 20,
};

/** Allowed ranges, inclusive. A stored value outside its range is ignored. */
const RANGES: Record<keyof Settings, [number, number]> = {
  rolloverHour: [0, 23],
  goalMin: [1, 240],
  maxNew: [0, 200],
  learnAheadMin: [0, 120],
};

/** The stored settings object with defaults filled in for anything missing or out of range. */
export function withDefaults(stored: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (typeof stored !== 'object' || stored === null) return out;
  for (const key of Object.keys(RANGES) as (keyof Settings)[]) {
    const v = (stored as Record<string, unknown>)[key];
    const [min, max] = RANGES[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}
