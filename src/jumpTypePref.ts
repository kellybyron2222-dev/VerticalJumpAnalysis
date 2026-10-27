import type { JumpType } from "./storage.ts";

export const JUMP_TYPE_PREF_KEY = "jumpLab.jumpType.v1";
export const DEFAULT_JUMP_TYPE: JumpType = "drop";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isJumpType(value: unknown): value is JumpType {
  return value === "drop" || value === "depth" || value === "oneStep" || value === "penultimate";
}

/** True for approach jumps that do not use a box. */
export function isApproachJumpType(jumpType: JumpType): boolean {
  return jumpType === "oneStep" || jumpType === "penultimate";
}

export function parseJumpType(raw: string | null | undefined): JumpType {
  if (isJumpType(raw)) return raw;
  return DEFAULT_JUMP_TYPE;
}

export function loadJumpTypePref(storage: KeyValueStore): JumpType {
  try {
    return parseJumpType(storage.getItem(JUMP_TYPE_PREF_KEY));
  } catch {
    return DEFAULT_JUMP_TYPE;
  }
}

export function saveJumpTypePref(storage: KeyValueStore, jumpType: JumpType): boolean {
  if (!isJumpType(jumpType)) return false;
  try {
    storage.setItem(JUMP_TYPE_PREF_KEY, jumpType);
    return true;
  } catch {
    return false;
  }
}

/** Cream metrics-strip column labels for export / on-image band. */
export function metricsStripLabelsForType(jumpType: JumpType): {
  height: string;
  contact: string;
  rsi: string;
} {
  if (isApproachJumpType(jumpType)) {
    return { height: "Jump height", contact: "Plant contact", rsi: "Plant RSI" };
  }
  return { height: "Jump height", contact: "Contact time", rsi: "RSI" };
}
