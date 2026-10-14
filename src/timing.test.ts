import { describe, expect, it } from "vitest";
import { GRAVITY_M_S2, METERS_PER_INCH, computeTrialMetrics } from "./metrics.ts";
import { IMG_0227_FRAME_TIMES } from "./img0227-times.ts";
import {
  cadenceFromIntervals,
  estimateBoxHeight,
  estimateFrameInterval,
  frameClockFromTicks,
  isVariableRate,
  measuredFps,
  mediaFrameRate,
  realSecondsFromMedia,
  rescaleFrame,
  metricStretch,
  sanityWarnings,
  sloMoStretch,
  slowFallStepOff,
  slowMoFactorFor,
  snapCaptureFps,
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

  it("fixes the inflated readout from an 8x clip without moving the marks", () => {
    // Marks sit on the capture-fps media grid. Dividing by the factor is the
    // whole correction; rescaling the frames as well would halve it again.
    const marks = { touchdown: 800, takeoff: 2720, landing: 6560, fps: 240 };
    const wrong = computeTrialMetrics({ ...marks, slowMoFactor: 1 });
    const fixed = computeTrialMetrics({ ...marks, slowMoFactor: 8 });
    expect(wrong?.gctMs).toBeCloseTo(8000, 6);
    expect(fixed?.gctMs).toBeCloseTo(1000, 6);
    expect(fixed?.flightMs).toBeCloseTo(2000, 6);
    expect(wrong!.heightM / fixed!.heightM).toBeCloseTo(64, 6);
    expect(wrong!.rsi / fixed!.rsi).toBeCloseTo(8, 6);
    expect(fixed?.gctMs).toBeCloseTo((computeTrialMetrics(marks)?.gctMs ?? 0) / 8, 6);
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

  it("flags a jump and a box estimate that cannot both be real", () => {
    expect(sanityWarnings({ heightIn: 15, gctMs: 250, boxHeightIn: 6 })).toEqual([]);
    expect(sanityWarnings({ heightIn: 18, gctMs: 220, boxHeightIn: 12 })).toEqual([]);
    const flagged = sanityWarnings({ heightIn: 245, gctMs: 400, boxHeightIn: 24 });
    expect(flagged.some((warning) => /disagree/i.test(warning))).toBe(true);
    expect(sanityWarnings({ heightIn: 12, gctMs: 250, boxHeightIn: 120 }).some((warning) => /disagree/i.test(warning))).toBe(
      true,
    );
  });
});

describe("frameClockFromTicks", () => {
  it("drops repeat callbacks for the same frame", () => {
    const clock = frameClockFromTicks([
      { mediaTime: 0, presentedFrames: 1 },
      { mediaTime: 0.0001, presentedFrames: 1 },
      { mediaTime: 1 / 60, presentedFrames: 2 },
      { mediaTime: 1 / 30, presentedFrames: 3 },
      { mediaTime: 1 / 20, presentedFrames: 4 },
    ]);
    expect(clock).toEqual([0, 0.016667, 0.033333, 0.05]);
    expect(measuredFps(clock!)).toBeCloseTo(60, 0);
  });
});

describe("clip windows", () => {
  it("uses the slow middle, not the real-time opening", () => {
    const cadence = cadenceFromIntervals([1 / 240, 1 / 120]);
    expect(cadence).toEqual({ fastFps: 240, slowFps: 120 });
    expect(slowMoFactorFor(snapCaptureFps(cadence!.fastFps) ?? 0, cadence!.slowFps)).toBe(2);
    expect(cadenceFromIntervals([null, null])).toBeNull();
    expect(snapCaptureFps(30)).toBeNull();
    expect(snapCaptureFps(232)).toBe(240);
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

  it("corrects a 6 in box filmed with a 2x stretch", () => {
    // Synthetic timings: the media grid has twice as many frames as real time,
    // so an uncorrected fall reads about 24 in (height scales with t²).
    const fall = Math.sqrt((2 * 6 * METERS_PER_INCH) / GRAVITY_M_S2);
    const airFrames = Math.round(fall * 240 * 2);
    const stepOff = 100;
    const touchdown = stepOff + 1 + airFrames;
    const raw = estimateBoxHeight(stepOff, touchdown, 240, 1);
    const fixed = estimateBoxHeight(stepOff, touchdown, 240, 2);
    expect(raw).not.toBeNull();
    expect(fixed).not.toBeNull();
    expect(raw!.heightIn).toBeCloseTo(24, 0);
    expect(fixed!.heightIn).toBeCloseTo(6, 0);
    expect(raw!.heightIn / fixed!.heightIn).toBeCloseTo(4, 1);

    const jump = computeTrialMetrics({
      touchdown,
      takeoff: touchdown + airFrames,
      landing: touchdown + airFrames * 2,
      fps: 240,
      slowMoFactor: 2,
    });
    const jumpRaw = computeTrialMetrics({
      touchdown,
      takeoff: touchdown + airFrames,
      landing: touchdown + airFrames * 2,
      fps: 240,
      slowMoFactor: 1,
    });
    expect(jump!.flightSeconds * 2).toBeCloseTo(jumpRaw!.flightSeconds, 8);
    expect(jumpRaw!.heightM / jump!.heightM).toBeCloseTo(4, 5);
    expect(jump!.rsi * 2).toBeCloseTo(jumpRaw!.rsi, 5);
    expect(jump!.gctSeconds).toBeCloseTo(fixed!.fallSeconds, 8);
  });

  it("recovers a 12 in box", () => {
    const fall = Math.sqrt((2 * 12 * METERS_PER_INCH) / GRAVITY_M_S2);
    const airFrames = Math.round(fall * 240);
    const estimate = estimateBoxHeight(50, 51 + airFrames, 240);
    expect(estimate!.heightIn).toBeCloseTo(12, 0);
  });

  it("turns IMG_0227's playback clock into a ~170 fps capture", () => {
    // Phone readout before this fix, from the playback timestamps with no
    // stretch: fps ~43, box ~28 in, jump ~230 in, contact ~850 ms, flight ~2200 ms.
    // Those marks: step-off 24, touchdown 40, takeoff 76, landing 170.
    const times = IMG_0227_FRAME_TIMES;
    const playback = measuredFps(times)!;
    expect(playback).toBeGreaterThan(40);
    expect(playback).toBeLessThan(46);
    expect(sloMoStretch(times)).toBe(4);
    expect(playback * 4).toBeGreaterThan(165);
    expect(playback * 4).toBeLessThan(180);
    expect(isVariableRate(times)).toBe(true);

    const visibleStep = 24;
    const touchdown = 40;
    const takeoff = 76;
    const landing = 170;
    const rawBox = estimateBoxHeight(visibleStep, touchdown, playback, 1, times);
    const rawJump = computeTrialMetrics({
      touchdown,
      takeoff,
      landing,
      fps: playback,
      slowMoFactor: 1,
      frameTimes: times,
    });
    expect(rawBox!.heightIn).toBeGreaterThan(25);
    expect(rawJump!.heightIn).toBeGreaterThan(200);
    expect(rawJump!.gctMs).toBeGreaterThan(800);
    expect(rawJump!.flightMs).toBeGreaterThan(2000);

    // A UI factor left at 1× must still apply the detected 4× — Byron's phone
    // produced 231 in when metrics trusted that 1× chip.
    expect(metricStretch(times, 1)).toBe(4);
    const phoneMarks = { touchdown: 29, takeoff: 67, landing: 160 };
    const phoneFixed = computeTrialMetrics({
      ...phoneMarks,
      fps: playback,
      slowMoFactor: metricStretch(times, 1),
      frameTimes: times,
    });
    expect(phoneFixed!.heightIn).toBeGreaterThan(12);
    expect(phoneFixed!.heightIn).toBeLessThan(18);
    expect(phoneFixed!.flightMs).toBeGreaterThan(450);
    expect(phoneFixed!.flightMs).toBeLessThan(650);

    const stepOff = slowFallStepOff(visibleStep, touchdown);
    const box = estimateBoxHeight(stepOff, touchdown, playback, metricStretch(times, 1), times);
    const jump = computeTrialMetrics({
      touchdown,
      takeoff,
      landing,
      fps: playback,
      slowMoFactor: metricStretch(times, 1),
      frameTimes: times,
    });
    expect(box!.heightIn).toBeGreaterThan(5);
    expect(box!.heightIn).toBeLessThan(8);
    expect(jump!.heightIn).toBeGreaterThan(12);
    expect(jump!.heightIn).toBeLessThan(18);
    expect(jump!.gctMs).toBeGreaterThan(150);
    expect(jump!.gctMs).toBeLessThan(300);
    expect(jump!.flightMs).toBeGreaterThan(450);
    expect(jump!.flightMs).toBeLessThan(650);
    expect(jump!.rsi).toBeGreaterThan(1);
    expect(jump!.rsi).toBeLessThan(3);
    expect(
      sanityWarnings({
        heightIn: jump!.heightIn,
        gctMs: jump!.gctMs,
        boxHeightIn: box!.heightIn,
        fallSeconds: box!.fallSeconds,
      }),
    ).toEqual([]);
  });

  it("does not time a variable-rate clip by its average fps", () => {
    // Photos can show one number (Byron saw 171) that is only the average of a
    // slowed middle and faster ends. The 6 in drop sits in the fast middle.
    const times: number[] = [0];
    const add = (count: number, dt: number) => {
      for (let i = 0; i < count; i += 1) times.push(times[times.length - 1] + dt);
    };
    add(5, 1 / 30);
    const stepOff = times.length - 1;
    const fallFrames = 42;
    add(fallFrames, 1 / 240);
    const touchdown = stepOff + 1 + fallFrames;
    add(122, 1 / 240);
    add(5, 1 / 30);

    const average = measuredFps(times)!;
    expect(average).toBeGreaterThan(160);
    expect(average).toBeLessThan(180);
    expect(isVariableRate(times)).toBe(true);

    const fromStamps = estimateBoxHeight(stepOff, touchdown, average, 1, times);
    const fromAverage = (touchdown - (stepOff + 1)) / average;
    expect(fromStamps!.fallSeconds).toBeCloseTo(fallFrames / 240, 6);
    expect(fromStamps!.heightIn).toBeCloseTo(6, 0);
    expect(Math.abs(fromStamps!.fallSeconds - fromAverage)).toBeGreaterThan(0.05);
    expect(
      sanityWarnings({ heightIn: 12, gctMs: 250, boxHeightIn: fromStamps!.heightIn, fallSeconds: fromStamps!.fallSeconds }),
    ).toEqual([]);
    expect(sanityWarnings({ heightIn: 12, gctMs: 250, fallSeconds: fromAverage * 4 }).some((line) => /free-fall/i.test(line))).toBe(
      true,
    );
  });

  it("rejects bad input", () => {
    expect(estimateBoxHeight(100, 101, 240)).toBeNull();
    expect(estimateBoxHeight(100, 90, 240)).toBeNull();
    expect(estimateBoxHeight(-1, 90, 240)).toBeNull();
    expect(estimateBoxHeight(10, 90, 0)).toBeNull();
    expect(estimateBoxHeight(10.5, 90, 240)).toBeNull();
  });
});
