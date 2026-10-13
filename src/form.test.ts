import { describe, expect, it } from "vitest";
import { trialFormError } from "./form.ts";

const valid = {
  fps: 240,
  jumpType: "drop",
  boxHeightIn: 12,
  armSwing: true,
  touchdown: 10,
  takeoff: 40,
  landing: 90,
};

describe("trialFormError", () => {
  it("accepts a complete trial", () => {
    expect(trialFormError(valid)).toBeNull();
  });

  it("names the first missing field", () => {
    expect(trialFormError({ ...valid, fps: null })).toMatch(/frame rate/i);
    expect(trialFormError({ ...valid, jumpType: null })).toMatch(/drop jump or depth jump/i);
    expect(trialFormError({ ...valid, boxHeightIn: 0 })).toMatch(/box height/i);
    expect(trialFormError({ ...valid, armSwing: null })).toMatch(/arms/i);
    expect(trialFormError({ ...valid, landing: null })).toMatch(/mark touchdown/i);
    expect(trialFormError({ ...valid, takeoff: 90, landing: 40 })).toMatch(/in that order/i);
  });
});
