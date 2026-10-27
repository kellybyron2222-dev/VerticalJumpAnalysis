import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  approachExtraMetrics,
  approachPlausibilityWarnings,
  detectPenultimate,
  detectPenultimateDetailed,
  listFootContactsBeforePlant,
  plantContactOutOfBand,
  penultimateContactOutOfBand,
  refineApproachPlantTouchdown,
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
    if (frame >= 20 && frame <= 44) footY = 0.92;
    else if (frame > 44 && frame < 60) footY = 0.75;
    else if (frame >= 60 && frame <= 85) footY = 0.93;
    else if (frame > 85 && frame < 120) {
      const t = (frame - 85) / 35;
      footY = 0.9 - 0.35 * 4 * t * (1 - t);
    } else if (frame >= 120) footY = 0.92;
    out.push({ frame, footY, footX: 0.45, heelY: footY, heelX: 0.45 });
  }
  return out;
}

/**
 * Left-foot penultimate (~100 ms at 240 fps) then both-foot plant.
 * Includes a 5-frame right-foot chatter that must not beat the real step.
 */
function perFootApproachClip(): FootSample[] {
  const out: FootSample[] = [];
  for (let frame = 0; frame <= 160; frame += 1) {
    let left = 0.78;
    let right = 0.78;
    if (frame >= 40 && frame <= 44) right = 0.92;
    if (frame >= 50 && frame <= 75) left = 0.93;
    if (frame > 75 && frame < 96) {
      left = 0.7;
      right = 0.7;
    }
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
      leftHeelY: left,
      rightHeelY: right,
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

  it("shows low-confidence chatter candidate instead of inventing nothing", () => {
    // 171.2 fps / 4×: 7 frames ≈ 41 ms real — below hard 50 ms, still returned + flagged.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 350; frame += 1) {
      let footY = 0.78;
      if (frame >= 270 && frame <= 276) footY = 0.93;
      if (frame >= 288 && frame <= 340) footY = 0.94;
      samples.push({ frame, footY, heelY: footY });
    }
    const result = detectPenultimateDetailed(samples, 288, timing);
    expect(result.marks).not.toBeNull();
    expect(result.lowConfidence).toBe(true);
    expect(result.reason).toMatch(/low-confidence|verify/i);
  });

  it("tracks left/right feet and prefers real step over chatter", () => {
    const marks = detectPenultimate(perFootApproachClip(), 96, timing240);
    expect(marks).not.toBeNull();
    expect(marks!.foot).toBe("L");
    expect(marks!.touchdown).toBeGreaterThanOrEqual(48);
    expect(marks!.takeoff).toBeLessThanOrEqual(80);
    const events = listFootContactsBeforePlant(perFootApproachClip(), 96, timing240);
    expect(events.some((e) => e.foot === "R" && e.takeoff - e.touchdown <= 5)).toBe(true);
    expect(events.some((e) => e.foot === "L" && e.takeoff - e.touchdown >= 20)).toBe(true);
  });

  it("refines plant TD to last plant-foot contact before takeoff", () => {
    // Other foot down early (80–100); plant foot hits at 110; TO at 150.
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 180; frame += 1) {
      let left = 0.7;
      let right = 0.7;
      if (frame >= 80 && frame <= 148) right = 0.93; // other foot early
      if (frame >= 110 && frame <= 148) left = 0.94; // plant foot
      if (frame >= 150) {
        left = 0.55;
        right = 0.55;
      }
      samples.push({
        frame,
        footY: Math.max(left, right),
        leftFootY: left,
        rightFootY: right,
        leftHeelY: left,
        rightHeelY: right,
      });
    }
    const refined = refineApproachPlantTouchdown(samples, 150, 80);
    expect(refined.touchdown).toBeGreaterThanOrEqual(108);
    expect(refined.touchdown).toBeLessThanOrEqual(112);
    expect(refined.reason).toMatch(/refined|plant-foot|last/i);
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
    expect(stepGapOutOfBand(120)).toBe(false);
    expect(stepGapOutOfBand(50)).toBe(true);
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
  });
});
