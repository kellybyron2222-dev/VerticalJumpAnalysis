import { describe, expect, it } from "vitest";
import {
  GRAVITY_M_S2,
  METERS_PER_INCH,
  computeTrialMetrics,
  jumpHeightMeters,
  metersToCentimeters,
  metersToInches,
  previewMetrics,
} from "./metrics.ts";

const FPS = 240;

describe("jump height", () => {
  it("uses g * t^2 / 8", () => {
    const flightSeconds = 0.5;
    const height = jumpHeightMeters(flightSeconds);
    expect(height).toBe((GRAVITY_M_S2 * flightSeconds * flightSeconds) / 8);
    expect(height).toBeCloseTo(0.3064578125, 10);
  });

  it("converts meters to inches and centimeters", () => {
    expect(metersToInches(METERS_PER_INCH)).toBeCloseTo(1, 10);
    expect(metersToCentimeters(0.3064578125)).toBeCloseTo(30.64578125, 8);
    expect(metersToInches(0.3064578125)).toBeCloseTo(12.0652682087, 8);
  });

  it("is zero when flight time is zero", () => {
    expect(jumpHeightMeters(0)).toBe(0);
  });
});

describe("computeTrialMetrics", () => {
  it("computes GCT, flight time, height, and RSI from frames", () => {
    // 60 frames at 240 fps = 0.25 s contact. 120 frames = 0.5 s flight.
    const metrics = computeTrialMetrics({
      touchdown: 0,
      takeoff: 60,
      landing: 180,
      fps: FPS,
    });
    expect(metrics).not.toBeNull();
    if (!metrics) return;

    expect(metrics.gctSeconds).toBeCloseTo(0.25, 10);
    expect(metrics.gctMs).toBeCloseTo(250, 10);
    expect(metrics.flightSeconds).toBeCloseTo(0.5, 10);
    expect(metrics.flightMs).toBeCloseTo(500, 10);
    expect(metrics.heightM).toBeCloseTo(0.3064578125, 10);
    expect(metrics.heightCm).toBeCloseTo(30.64578125, 8);
    expect(metrics.heightIn).toBeCloseTo(12.0652682087, 8);
    expect(metrics.rsi).toBeCloseTo(metrics.heightM / metrics.gctSeconds, 10);
    expect(metrics.rsi).toBeCloseTo(1.22583125, 8);
  });

  it("treats one frame at 240 fps as 1000/240 ms", () => {
    const metrics = computeTrialMetrics({
      touchdown: 10,
      takeoff: 11,
      landing: 12,
      fps: FPS,
    });
    expect(metrics).not.toBeNull();
    if (!metrics) return;
    expect(metrics.gctMs).toBeCloseTo(1000 / 240, 10);
    expect(metrics.flightMs).toBeCloseTo(1000 / 240, 10);
  });

  it("rejects unordered or non-integer frames and bad fps", () => {
    expect(
      computeTrialMetrics({ touchdown: 5, takeoff: 5, landing: 9, fps: FPS }),
    ).toBeNull();
    expect(
      computeTrialMetrics({ touchdown: 8, takeoff: 4, landing: 12, fps: FPS }),
    ).toBeNull();
    expect(
      computeTrialMetrics({ touchdown: 1, takeoff: 4, landing: 4, fps: FPS }),
    ).toBeNull();
    expect(
      computeTrialMetrics({ touchdown: 1.5, takeoff: 4, landing: 8, fps: FPS }),
    ).toBeNull();
    expect(
      computeTrialMetrics({ touchdown: 1, takeoff: 4, landing: 8, fps: 0 }),
    ).toBeNull();
    expect(
      computeTrialMetrics({ touchdown: 1, takeoff: 4, landing: 8, fps: -240 }),
    ).toBeNull();
  });
});

describe("previewMetrics", () => {
  it("shows GCT before landing is marked", () => {
    const preview = previewMetrics({
      touchdown: 100,
      takeoff: 148,
      landing: null,
      fps: FPS,
    });
    expect(preview.gctMs).toBeCloseTo((48 / 240) * 1000, 10);
    expect(preview.flightMs).toBeNull();
    expect(preview.rsi).toBeNull();
    expect(preview.message).toBe("Mark touchdown, takeoff, and landing.");
  });

  it("fills every metric once the three marks are in order", () => {
    const preview = previewMetrics({
      touchdown: 0,
      takeoff: 60,
      landing: 180,
      fps: FPS,
    });
    expect(preview.message).toBeNull();
    expect(preview.gctMs).toBeCloseTo(250, 10);
    expect(preview.flightMs).toBeCloseTo(500, 10);
    expect(preview.heightIn).toBeCloseTo(12.0652682087, 8);
    expect(preview.rsi).toBeCloseTo(1.22583125, 8);
  });

  it("withholds numbers when the marks are out of order", () => {
    const preview = previewMetrics({
      touchdown: 20,
      takeoff: 10,
      landing: 5,
      fps: FPS,
    });
    expect(preview.gctMs).toBeNull();
    expect(preview.flightMs).toBeNull();
    expect(preview.heightIn).toBeNull();
    expect(preview.rsi).toBeNull();
    expect(preview.message).toMatch(/in that order/);
  });

  it("asks for a frame rate before it does any math", () => {
    const preview = previewMetrics({
      touchdown: 0,
      takeoff: 10,
      landing: 20,
      fps: 0,
    });
    expect(preview.message).toMatch(/frame rate/i);
    expect(preview.gctMs).toBeNull();
  });
});
