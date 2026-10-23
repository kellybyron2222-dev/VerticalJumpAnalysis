import { describe, expect, it } from "vitest";
import {
  BOX_HEIGHT_PRESETS,
  DEFAULT_BOX_HEIGHT_IN,
  isBoxHeightPreset,
  loadBoxHeightPref,
  saveBoxHeightPref,
} from "./boxHeightPref.ts";

function memoryStore(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("box height preference", () => {
  it("defaults to 6 in", () => {
    expect(DEFAULT_BOX_HEIGHT_IN).toBe(6);
    expect(loadBoxHeightPref(memoryStore())).toBe(6);
    expect(BOX_HEIGHT_PRESETS).toEqual([6, 8, 10, 12, 14, 16, 18]);
  });

  it("round-trips a preset and a custom value", () => {
    const store = memoryStore();
    expect(saveBoxHeightPref(store, 12)).toBe(true);
    expect(loadBoxHeightPref(store)).toBe(12);
    expect(isBoxHeightPreset(12)).toBe(true);
    expect(saveBoxHeightPref(store, 9.5)).toBe(true);
    expect(loadBoxHeightPref(store)).toBe(9.5);
    expect(isBoxHeightPreset(9.5)).toBe(false);
  });

  it("rejects non-positive values", () => {
    const store = memoryStore();
    expect(saveBoxHeightPref(store, 0)).toBe(false);
    expect(saveBoxHeightPref(store, -1)).toBe(false);
    expect(loadBoxHeightPref(store)).toBe(6);
  });
});
