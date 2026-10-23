export const BOX_HEIGHT_PRESETS = [6, 8, 10, 12, 14, 16, 18] as const;
export type BoxHeightPreset = (typeof BOX_HEIGHT_PRESETS)[number];

export const BOX_HEIGHT_PREF_KEY = "jumpLab.boxHeightIn.v1";
/** Default for drop jumps (and first launch). */
export const DEFAULT_BOX_HEIGHT_IN = 6;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isBoxHeightPreset(value: number): value is BoxHeightPreset {
  return (BOX_HEIGHT_PRESETS as readonly number[]).includes(value);
}

export function loadBoxHeightPref(storage: KeyValueStore): number {
  try {
    const raw = storage.getItem(BOX_HEIGHT_PREF_KEY);
    if (raw === null || raw === "") return DEFAULT_BOX_HEIGHT_IN;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_BOX_HEIGHT_IN;
    return value;
  } catch {
    return DEFAULT_BOX_HEIGHT_IN;
  }
}

export function saveBoxHeightPref(storage: KeyValueStore, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    storage.setItem(BOX_HEIGHT_PREF_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}
