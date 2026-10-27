import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  approachExtraMetrics,
  approachPlausibilityWarnings,
  detectPenultimate,
  detectPenultimateDetailed,
  listFootContactsBeforePlant,
  mergeContactFragments,
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

  it("rejects sub-50 ms chatter instead of auto-applying a fragment", () => {
    // 171.2 fps / 4×: 7 frames ≈ 41 ms real — below hard 50 ms → marks null.
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
    expect(result.marks).toBeNull();
    expect(result.reason).toMatch(/no penultimate|≥50/i);
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

  it("finds device-like R66–92 when right heel sits above combined plant floor", () => {
    // Phone heavy: plant left reaches ~0.96; penultimate right heel only ~0.91.
    // Combined ground≈0.95 would miss R if L/R reused that floor.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 320; frame += 1) {
      let left = 0.72;
      let right = 0.72;
      if (frame >= 66 && frame <= 92) right = 0.91;
      if (frame > 92 && frame < 109) {
        left = 0.68;
        right = 0.68;
      }
      if (frame >= 109 && frame <= 162) {
        left = 0.96;
        if (frame >= 120) right = 0.94;
      }
      if (frame >= 163 && frame < 287) {
        left = 0.5;
        right = 0.5;
      }
      if (frame >= 287) {
        left = 0.93;
        right = 0.93;
      }
      samples.push({
        frame,
        footY: Math.max(left, right),
        heelY: Math.max(left, right),
        leftFootY: left,
        rightFootY: right,
        leftHeelY: left,
        rightHeelY: right,
      });
    }
    const events = listFootContactsBeforePlant(samples, 109, timing);
    // Combined floor misses shallow R; per-foot ground must still list it.
    expect(events.some((e) => e.foot === "R" && e.touchdown <= 70 && e.takeoff >= 88)).toBe(
      true,
    );
    const pen = detectPenultimateDetailed(samples, 109, timing);
    expect(pen.marks).not.toBeNull();
    expect(pen.marks!.foot).toBe("R");
    expect(pen.marks!.touchdown).toBeGreaterThanOrEqual(64);
    expect(pen.marks!.touchdown).toBeLessThanOrEqual(70);
    expect(pen.marks!.takeoff).toBeGreaterThanOrEqual(88);
    expect(pen.marks!.takeoff).toBeLessThan(109);
    expect(pen.lowConfidence).toBe(false);
  });

  it("refines plant TD to plant-foot first hit, not earlier other-foot", () => {
    // Other foot early then leaves; plant foot hits at 110; TO at 150 (~167 ms @240fps).
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 180; frame += 1) {
      let left = 0.7;
      let right = 0.7;
      if (frame >= 80 && frame <= 100) right = 0.93; // other foot (pen) then air
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
    const refined = refineApproachPlantTouchdown(samples, 150, 80, timing240);
    expect(refined.touchdown).toBeGreaterThanOrEqual(108);
    expect(refined.touchdown).toBeLessThanOrEqual(112);
    expect(refined.reason).toMatch(/refined|first hit/i);
  });

  it("rejects near-TO blink refine (<80 ms) and keeps unrefined plant TD", () => {
    // Byron 2026-10-27e failure: real plant ~109–163, pose blink on other foot near TO → 8 ms.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 200; frame += 1) {
      let left = 0.7;
      let right = 0.7;
      if (frame >= 109 && frame <= 162) left = 0.94; // real plant
      if (frame >= 160 && frame <= 162) right = 0.94; // late blink / other foot
      if (frame >= 163) {
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
    const refined = refineApproachPlantTouchdown(samples, 163, 109, timing);
    expect(refined.touchdown).toBe(109);
    expect(refined.reason).toMatch(/TD109|315|first hit/i);
    const plantMs =
      ((163 - refined.touchdown) / playback / 4) * 1000;
    expect(plantMs).toBeGreaterThanOrEqual(150);
    expect(plantMs).toBeLessThanOrEqual(350);
  });

  it("Byron penultimate clip marks: plant ~317 ms, pen before plant, gap = pen TO→plant TD", () => {
    // Frames from build d (IMG_0403): plant TD109 TO163 LD~287; pen before plant.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 320; frame += 1) {
      let left = 0.72;
      let right = 0.72;
      // Penultimate right foot ~66–92 (~152 ms)
      if (frame >= 66 && frame <= 92) right = 0.93;
      // Step gap air 93–108
      if (frame > 92 && frame < 109) {
        left = 0.68;
        right = 0.68;
      }
      // Plant left (+ both) 109–162
      if (frame >= 109 && frame <= 162) {
        left = 0.94;
        if (frame >= 120) right = 0.93;
      }
      if (frame >= 163 && frame < 287) {
        left = 0.5;
        right = 0.5;
      }
      if (frame >= 287) {
        left = 0.93;
        right = 0.93;
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
    const plant = refineApproachPlantTouchdown(samples, 163, 109, timing);
    expect(plant.touchdown).toBe(109);
    // Contact TD109→TO163 ≈ 317 ms at 171.2 fps / 4×
    const gct = approachExtraMetrics({
      plantTouchdown: 163,
      penultimateTouchdown: 109,
      penultimateTakeoff: 163,
      fps: 171.2,
      stretch: 4,
      frameTimes: timing.frameTimes,
    }).penultimateGctMs!;
    expect(gct).toBeGreaterThanOrEqual(150);
    expect(gct).toBeLessThanOrEqual(350);

    const pen = detectPenultimateDetailed(samples, plant.touchdown, timing);
    expect(pen.marks).not.toBeNull();
    expect(pen.marks!.takeoff).toBeLessThan(plant.touchdown);
    const extra = approachExtraMetrics({
      plantTouchdown: plant.touchdown,
      penultimateTouchdown: pen.marks!.touchdown,
      penultimateTakeoff: pen.marks!.takeoff,
      fps: 171.2,
      stretch: 4,
      frameTimes: timing.frameTimes,
    });
    expect(extra.penultimateGctMs!).toBeGreaterThanOrEqual(80);
    expect(extra.stepGapMs!).toBeGreaterThanOrEqual(30);
    expect(extra.stepGapMs!).toBeLessThan(400);
  });

  it("merges fragmented R66–92 and rejects short toe-off end (Byron 27g phone)", () => {
    // Phone 27g: pose split the right penultimate; late fragment ~45.8 ms won.
    // Gap between fragments ≤25 ms real → merge; pen ≈130–180, gap ≈80–130.
    const playback = 171.2 / 4;
    const timing = { fps: 171.2, stretch: 4, frameTimes: pts(400, playback) };
    const samples: FootSample[] = [];
    for (let frame = 0; frame <= 320; frame += 1) {
      let left = 0.72;
      let right = 0.72;
      let rightToe: number | undefined;
      // Fragment A 66–78, brief hole, fragment B 82–92 (gap ~23 ms @171.2/4×).
      if (frame >= 66 && frame <= 78) {
        right = 0.91;
        rightToe = 0.93;
      }
      if (frame >= 82 && frame <= 92) {
        right = 0.9;
        rightToe = 0.92;
      }
      if (frame > 92 && frame < 109) {
        left = 0.68;
        right = 0.68;
      }
      if (frame >= 109 && frame <= 162) {
        left = 0.96;
        if (frame >= 120) right = 0.94;
      }
      if (frame >= 163 && frame < 287) {
        left = 0.5;
        right = 0.5;
      }
      if (frame >= 287) {
        left = 0.93;
        right = 0.93;
      }
      samples.push({
        frame,
        footY: Math.max(left, right),
        heelY: Math.max(left, right),
        leftFootY: left,
        rightFootY: right,
        leftHeelY: left,
        rightHeelY: right,
        rightToeY: rightToe,
      });
    }
    const merged = mergeContactFragments(
      [
        { foot: "R", touchdown: 66, takeoff: 78, contactMs: null },
        { foot: "R", touchdown: 82, takeoff: 92, contactMs: null },
      ],
      timing,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.touchdown).toBe(66);
    expect(merged[0]!.takeoff).toBe(92);

    const pen = detectPenultimateDetailed(samples, 109, timing);
    expect(pen.marks).not.toBeNull();
    expect(pen.marks!.foot).toBe("R");
    expect(pen.marks!.touchdown).toBeGreaterThanOrEqual(64);
    expect(pen.marks!.touchdown).toBeLessThanOrEqual(70);
    expect(pen.marks!.takeoff).toBeGreaterThanOrEqual(88);
    expect(pen.marks!.takeoff).toBeLessThan(109);
    const extra = approachExtraMetrics({
      plantTouchdown: 109,
      penultimateTouchdown: pen.marks!.touchdown,
      penultimateTakeoff: pen.marks!.takeoff,
      fps: 171.2,
      stretch: 4,
      frameTimes: timing.frameTimes,
    });
    expect(extra.penultimateGctMs!).toBeGreaterThanOrEqual(130);
    expect(extra.penultimateGctMs!).toBeLessThanOrEqual(180);
    expect(extra.stepGapMs!).toBeGreaterThanOrEqual(80);
    expect(extra.stepGapMs!).toBeLessThanOrEqual(130);
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
