export type JumpCountChoice = "auto" | 1 | 2 | 3 | 4;

export const JUMP_COUNT_PREF_KEY = "jumpLab.jumpsInClip.v1";
export const DEFAULT_JUMP_COUNT: JumpCountChoice = "auto";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseJumpCountChoice(raw: string | null | undefined): JumpCountChoice {
  if (raw === null || raw === undefined || raw === "" || raw === "auto") return "auto";
  const n = Number(raw);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return "auto";
}

export function loadJumpCountPref(storage: KeyValueStore): JumpCountChoice {
  try {
    return parseJumpCountChoice(storage.getItem(JUMP_COUNT_PREF_KEY));
  } catch {
    return DEFAULT_JUMP_COUNT;
  }
}

export function saveJumpCountPref(storage: KeyValueStore, value: JumpCountChoice): boolean {
  try {
    storage.setItem(JUMP_COUNT_PREF_KEY, value === "auto" ? "auto" : String(value));
    return true;
  } catch {
    return false;
  }
}
