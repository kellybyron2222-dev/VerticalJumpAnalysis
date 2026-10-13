import { describe, expect, it } from "vitest";
import { GRAVITY_M_S2, METERS_PER_INCH, computeTrialMetrics } from "./metrics.ts";
import {
  estimateBoxHeight,
  estimateFrameInterval,
  mediaFrameRate,
  realSecondsFromMedia,
  rescaleFrame,
  sanityWarnings,
  slowMoFactorFor,
  type FrameTick,
} from "./timing.ts";

function ticks(interval: number, steps: number[]): FrameTick[] {
  const out: FrameTick[] = [{ mediaTime: 1, presentedFrames: 10 }];
  for (const step of steps) {
    const last = out[out.length - 1];
    out.push({ mediaTime: last.mediaTime + interval * step, presentedFrames: last.presentedFrames + 1 });
  }
  return out;
}

describe("estimateFrameInterval", () => {
  it("reads a 240 fps clip", () => {
    expect(estimateFrameInterval(ticks(1 / 240, [1, 1, 1, 1, 1, 1]))).toBeCloseTo(1 / 240, 9);
  });

  it("reads a stretched clip at 30 fps", () => {
    expect(estimateFrameInterval(ticks(1 / 30, [1, 1, 1, 1, 1]))).toBeCloseTo(1 / 30, 9);
  });

  it("ignores gaps from dropped display frames", () => {
    expect(estimateFrameInterval(ticks(1 / 240, [1, 2, 1, 2, 1, 3, 1, 2]))).toBeCloseTo(1 / 240, 9);
  });

  it("needs a few readings", () => {
    expect(estimateFrameInterval(ticks(1 / 240, [1]))).toBeNull();
    expect(estimateFrameInterval([])).toBeNull();
  });
});

describe("slowMoFactorFor", () => {
  it("snaps to common factors", () => {
    expect(slowMoFactorFor(240, 240)).toBe(1);
    expect(slowMoFactorFor(240, 60)).toBe(4);
    expect(slowMoFactorFor(240, 30)).toBe(8);
    expect(slowMoFactorFor(240, 29.97)).toBe(8);
    expect(slowMoFactorFor(240, 120)).toBe(2);
  });

  it("never goes below 1 and handles bad input", () => {
    expect(slowMoFactorFor(240, 480)).toBe(1);
    expect(slowMoFactorFor(240, 0)).toBe(1);
    expect(slowMoFactorFor(0, 30)).toBe(1);
    expect(slowMoFactorFor(240, 48)).toBe(5);
  });
});

describe("real time", () => {
  it("maps media seconds to real seconds", () => {
    expect(realSecondsFromMedia(2, 8)).toBe(0.25);
    expect(realSecondsFromMedia(2, 1)).toBe(2);
    expect(mediaFrameRate(240, 8)).toBe(30);
    expect(mediaFrameRate(240, 1)).toBe(240);
  });

  it("fixes the inflated readout from an 8x clip", () => {
    // Marks placed on a 240-per-media-second grid in a clip stretched 8x.
    const wrong = computeTrialMetrics({ touchdown: 800, takeoff: 2720, landing: 6560, fps: 240 });
    const fixed = computeTrialMetrics({
      touchdown: rescaleFrame(800, 1, 8),
      takeoff: rescaleFrame(2720, 1, 8),
      landing: rescaleFrame(6560, 1, 8),
      fps: 240,
    });
    expect(wrong?.gctMs).toBeCloseTo(8000, 6);
    expect(fixed?.gctMs).toBeCloseTo(1000, 6);
    expect(fixed?.flightMs).toBeCloseTo(2000, 6);
    expect(wrong!.heightM / fixed!.heightM).toBeCloseTo(64, 6);
    expect(wrong!.rsi / fixed!.rsi).toBeCloseTo(8, 6);
  });

  it("rescales frames to the same moment", () => {
    expect(rescaleFrame(960, 1, 8)).toBe(120);
    expect(rescaleFrame(120, 8, 1)).toBe(960);
    expect(rescaleFrame(10, 4, 4)).toBe(10);
  });
});

describe("sanityWarnings", () => {
  it("is quiet for normal numbers", () => {
    expect(sanityWarnings({ heightIn: 15, gctMs: 250 })).toEqual([]);
    expect(sanityWarnings({ heightIn: null, gctMs: null })).toEqual([]);
    expect(sanityWarnings({ heightIn: 40, gctMs: 80 })).toEqual([]);
    expect(sanityWarnings({ heightIn: 2, gctMs: 1000 })).toEqual([]);
  });

  it("flags unlikely height and contact time", () => {
    expect(sanityWarnings({ heightIn: 241.61, gctMs: 250 })).toEqual(["Jump height is over 40 in."]);
    expect(sanityWarnings({ heightIn: 1.5, gctMs: 250 })).toEqual(["Jump height is under 2 in."]);
    expect(sanityWarnings({ heightIn: 15, gctMs: 79 })).toHaveLength(1);
    expect(sanityWarnings({ heightIn: 15, gctMs: 1001 })).toHaveLength(1);
    expect(sanityWarnings({ heightIn: 50, gctMs: 2000 })).toHaveLength(2);
  });
});

describe("estimateBoxHeight", () => {
  it("uses h = g t^2 / 2 on the airborne frames", () => {
    // 72 airborne frames at 240 fps = 0.3 s.
    const estimate = estimateBoxHeight(100, 173, 240);
    expect(estimate).not.toBeNull();
    expect(estimate!.fallSeconds).toBeCloseTo(0.3, 10);
    expect(estimate!.heightM).toBeCloseTo((GRAVITY_M_S2 * 0.09) / 2, 10);
    expect(estimate!.heightIn).toBeCloseTo(estimate!.heightM / METERS_PER_INCH, 10);
    expect(estimate!.heightCm).toBeCloseTo(estimate!.heightM * 100, 10);
  });

  it("recovers a 12 in box", () => {
    const fall = Math.sqrt((2 * 12 * METERS_PER_INCH) / GRAVITY_M_S2);
    const airFrames = Math.round(fall * 240);
    const estimate = estimateBoxHeight(50, 51 + airFrames, 240);
    expect(estimate!.heightIn).toBeCloseTo(12, 0);
  });

  it("rejects bad input", () => {
    expect(estimateBoxHeight(100, 101, 240)).toBeNull();
    expect(estimateBoxHeight(100, 90, 240)).toBeNull();
    expect(estimateBoxHeight(-1, 90, 240)).toBeNull();
    expect(estimateBoxHeight(10, 90, 0)).toBeNull();
    expect(estimateBoxHeight(10.5, 90, 240)).toBeNull();
  });
});
