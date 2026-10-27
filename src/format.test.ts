import { describe, expect, it } from "vitest";
import {
  formatArmSwing,
  formatBoxInches,
  formatClock,
  formatHeightCm,
  formatHeightIn,
  formatJumpType,
  formatInValue,
  formatMilliseconds,
  formatMsValue,
  formatRsi,
  formatTrialTitle,
} from "./format.ts";

describe("formatters", () => {
  it("formats the live readout", () => {
    expect(formatMilliseconds(250)).toBe("250.0 ms");
    expect(formatMilliseconds(1000 / 240)).toBe("4.2 ms");
    expect(formatHeightIn(12.0652682087)).toBe("12.07 in");
    expect(formatHeightCm(30.64578125)).toBe("30.6 cm");
    expect(formatRsi(1.22583125)).toBe("1.23");
    expect(formatMsValue(249.6)).toBe("250");
    expect(formatInValue(15.104)).toBe("15.10");
    expect(formatClock(0.25)).toBe("0.250 s");
  });

  it("formats box height and trial labels", () => {
    expect(formatBoxInches(12)).toBe("12 in");
    expect(formatBoxInches(12.5)).toBe("12.5 in");
    expect(formatBoxInches(12.25)).toBe("12.25 in");
    expect(formatJumpType("drop")).toBe("Drop jump");
    expect(formatJumpType("depth")).toBe("Depth jump");
    expect(formatJumpType("oneStep")).toBe("One-step");
    expect(formatJumpType("penultimate")).toBe("Penultimate / Approach");
    expect(formatTrialTitle("penultimate", 0)).toBe("Penultimate / Approach");
    expect(formatTrialTitle("oneStep", 0)).toBe("One-step");
    expect(formatTrialTitle("drop", 12)).toBe("Drop jump · 12 in");
    expect(formatArmSwing(true)).toBe("Arm swing");
    expect(formatArmSwing(false)).toBe("No arm swing");
  });
});
