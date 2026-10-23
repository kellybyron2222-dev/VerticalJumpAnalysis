import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUMP_COUNT,
  loadJumpCountPref,
  parseJumpCountChoice,
  saveJumpCountPref,
} from "./jumpCountPref.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("jumpCountPref", () => {
  it("defaults to Auto", () => {
    expect(DEFAULT_JUMP_COUNT).toBe("auto");
    expect(loadJumpCountPref(memoryStore())).toBe("auto");
    expect(parseJumpCountChoice("nope")).toBe("auto");
  });

  it("remembers 1–4", () => {
    const store = memoryStore();
    expect(saveJumpCountPref(store, 2)).toBe(true);
    expect(loadJumpCountPref(store)).toBe(2);
    saveJumpCountPref(store, "auto");
    expect(loadJumpCountPref(store)).toBe("auto");
  });
});
