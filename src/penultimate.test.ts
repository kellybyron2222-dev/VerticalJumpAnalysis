import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  approachExtraMetrics,
  approachPlausibilityWarnings,
  detectPenultimate,
  listFootContactsBeforePlant,
  plantContactOutOfBand,
  penultimateContactOutOfBand,
  stepGapOutOfBand,
} from "./penultimate.ts";

/** Presentation clock ≈ capture/stretch so 4× divides media time to real. */
function pts(frameCount: number, playbackFps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < frameCount; i += 1) times.push(i / playbackFps);
  return times;
}

const timing240 = { fps: 240, stretch: 1 as const };

/** Standing → pen contact (~100 ms) → step gap → plant → takeoff → land. */
function approachClip(): FootSample[] {
  const out: FootSample[] = [];
  for (let frame = 0; frame <= 140; frame += 1) {
    let footY = 0.9;
    // Penultimate contact 20–44 (24 frames ≈ 100 ms at 240 fps)
    if (frame >= 20 && frame <= 44) footY = 0.92;
    // Flight / step gap to plant 45–59 (~62 ms)
    else if (frame > 44 && frame < 60) footY = 0.75;
    // Plant 60–85
    else if (frame >= 60 && frame <= 85) footY = 0.93;
    // Jump flight 86–120
    else if (frame > 85 && frame < 120) {
      const t = (frame - 85) / 35;
      footY = 0.9 - 0.35 * 4 * t * (1 - t);
    } else if (frame >= 120) footY = 0.92;
    out.push({ frame, footY, footX: 0.45, heelY: footY, heelX: 0.45 });
  }
  return out;
}

/**
 * Left-foot penultimate (~100 ms at 240 fps = 24 frames) then both-foot plant.
 * Includes a 5-frame right-foot chatter that must not be chosen.
 */
function perFootApproachClip(): FootSample[] {
  const out: FootSample[] = [];
  for (let frame = 0; frame <= 160; frame += 1) {
    let left = 0.78;
    let right = 0.78;
    // Chatter on right: brief ground blink 40–44
    if (frame >= 40 && frame <= 44) right = 0.92;
    // Real penultimate on left 50–75 (~108 ms)
    if (frame >= 50 && frame <= 75) left = 0.93;
    // Step gap air 76–95
    if (frame > 75 && frame < 96) {
      left = 0.7;
      right = 0.7;
    }
    // Bilateral plant 96–130
    if (frame >= 96 && frame <= 130) {
      left = 0.94;
      right = 0.94;
    }
    if (frame > 130 && frame < 155) {
      left = 0.55;
      right = 0.55;
    }
    if (frame >= 155) {
      left = 0.93;
      right = 0.93;
    }
    const footY = Math.max(left, right);
    out.push({
      frame,
      footY,
      leftFootY: left,
      rightFootY: right,
      upperFootY: Math.min(left, right),
    });
  }
  return out;
}

describe("penultimate detect", () => {
  it("finds penultimate contact before plant touchdown", () => {
    const marks = detectPenultimate(approachClip(), 60, timing240);
    expect(marks).not.toBeNull();
    expect(marks!.touchdown).toBeGreaterThanOrEqual(18);
    expect(marks!.touchdown).toBeLessThanOrEqual(25);
    expect(marks!.takeoff).toBeGreaterThanOrEqual(40);
    expect(marks!.takeoff).toBeLessThan(60);
  });

  it("returns null without a prior step", () => {
    const onlyPlant: FootSample[] = [];
    for (let frame = 0; frame <= 40; frame += 1) {
      onlyPlant.push({ frame, footY: frame < 10 ? 0.9 : frame < 25 ? 0.92 : 0.7 });
    }
    expect(detectPenultimate(onlyPlant, 10, timing240)).toBeNull();
  });

  it("rejects foot-chatter penultimate (< 80 ms contact)", () => {
    // 171.2 fps / 4×: 7 frames ≈ 41 ms real — Byron's 42 ms false penultimate.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 350; frame += 1) {
      let footY = 0.78;
      if (frame >= 270 && frame <= 276) footY = 0.93; // ~7 frames chatter
      if (frame >= 288 && frame <= 340) footY = 0.94; // plant
      samples.push({ frame, footY });
    }
    expect(detectPenultimate(samples, 288, timing)).toBeNull();
  });

  it("tracks left/right feet and ignores opposite-foot chatter", () => {
    const marks = detectPenultimate(perFootApproachClip(), 96, timing240);
    expect(marks).not.toBeNull();
    expect(marks!.foot).toBe("L");
    expect(marks!.touchdown).toBeGreaterThanOrEqual(48);
    expect(marks!.touchdown).toBeLessThanOrEqual(55);
    expect(marks!.takeoff).toBeGreaterThanOrEqual(70);
    expect(marks!.takeoff).toBeLessThanOrEqual(80);
    const events = listFootContactsBeforePlant(perFootApproachClip(), 96, timing240);
    expect(events.some((e) => e.foot === "R" && e.takeoff - e.touchdown <= 5)).toBe(true);
    expect(events.some((e) => e.foot === "L" && e.takeoff - e.touchdown >= 20)).toBe(true);
  });

  it("computes penultimate GCT and step gap", () => {
    const extra = approachExtraMetrics({
      plantTouchdown: 50,
      penultimateTouchdown: 20,
      penultimateTakeoff: 35,
      fps: 240,
      stretch: 1,
    });
    expect(extra.penultimateGctMs).toBeCloseTo((15 / 240) * 1000, 5);
    expect(extra.stepGapMs).toBeCloseTo((15 / 240) * 1000, 5);
  });

  it("flags plant / penultimate / step-gap bands", () => {
    expect(plantContactOutOfBand(200)).toBe(false);
    expect(plantContactOutOfBand(100)).toBe(true);
    expect(penultimateContactOutOfBand(150)).toBe(false);
    expect(penultimateContactOutOfBand(42)).toBe(true);
    expect(penultimateContactOutOfBand(350)).toBe(true);
    expect(stepGapOutOfBand(120)).toBe(false);
    expect(stepGapOutOfBand(50)).toBe(true);
    expect(stepGapOutOfBand(500)).toBe(true);
  });

  it("emits Check marks when penultimate missing or out of band", () => {
    expect(
      approachPlausibilityWarnings({
        penultimateGctMs: null,
        stepGapMs: null,
        plantFlightMs: 500,
        penultimateFound: false,
      })[0],
    ).toMatch(/penultimate step not found/i);
    const flagged = approachPlausibilityWarnings({
      penultimateGctMs: 42,
      stepGapMs: 63,
      plantFlightMs: 400,
      largestFlightMs: 600,
      penultimateFound: true,
    });
    expect(flagged.some((w) => /penultimate contact/i.test(w))).toBe(true);
    expect(flagged.some((w) => /largest clip flight/i.test(w))).toBe(true);
  });
});
