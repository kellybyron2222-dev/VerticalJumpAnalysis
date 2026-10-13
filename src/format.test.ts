import { describe, expect, it } from "vitest";
import {
  formatArmSwing,
  formatBoxInches,
  formatClock,
  formatHeightCm,
  formatHeightIn,
  formatJumpType,
  formatMilliseconds,
  formatRsi,
} from "./format.ts";

describe("formatters", () => {
  it("formats the live readout", () => {
    expect(formatMilliseconds(250)).toBe("250.0 ms");
    expect(formatMilliseconds(1000 / 240)).toBe("4.2 ms");
    expect(formatHeightIn(12.0652682087)).toBe("12.07 in");
    expect(formatHeightCm(30.64578125)).toBe("30.6 cm");
    expect(formatRsi(1.22583125)).toBe("1.23 m/s");
    expect(formatClock(0.25)).toBe("0.250 s");
  });

  it("formats box height and trial labels", () => {
    expect(formatBoxInches(12)).toBe("12 in");
    expect(formatBoxInches(12.5)).toBe("12.5 in");
    expect(formatBoxInches(12.25)).toBe("12.25 in");
    expect(formatJumpType("drop")).toBe("Drop jump");
    expect(formatJumpType("depth")).toBe("Depth jump");
    expect(formatArmSwing(true)).toBe("Arm swing");
    expect(formatArmSwing(false)).toBe("No arm swing");
  });
});
