import { describe, expect, it } from "vitest";
import {
  isApproachJumpType,
  isJumpType,
  loadJumpTypePref,
  metricsStripLabelsForType,
  parseJumpType,
  saveJumpTypePref,
} from "./jumpTypePref.ts";

describe("jumpTypePref", () => {
  it("parses and remembers approach types", () => {
    expect(isJumpType("oneStep")).toBe(true);
    expect(isJumpType("penultimate")).toBe(true);
    expect(isApproachJumpType("oneStep")).toBe(true);
    expect(isApproachJumpType("drop")).toBe(false);
    expect(parseJumpType("penultimate")).toBe("penultimate");
    expect(parseJumpType("nope")).toBe("drop");

    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
    };
    expect(saveJumpTypePref(store, "oneStep")).toBe(true);
    expect(loadJumpTypePref(store)).toBe("oneStep");
    expect(metricsStripLabelsForType("oneStep").contact).toBe("Plant contact");
    expect(metricsStripLabelsForType("drop").contact).toBe("Contact time");
  });
});
