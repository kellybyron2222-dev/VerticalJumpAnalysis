import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  approachExtraMetrics,
  detectPenultimate,
  plantContactOutOfBand,
} from "./penultimate.ts";

/** Standing → pen contact → short flight → plant → takeoff → land. */
function approachClip(): FootSample[] {
  const out: FootSample[] = [];
  for (let frame = 0; frame <= 120; frame += 1) {
    let footY = 0.9;
    // Penultimate contact 20–35
    if (frame >= 20 && frame <= 35) footY = 0.92;
    // Flight to plant 36–49
    else if (frame > 35 && frame < 50) footY = 0.75;
    // Plant 50–70
    else if (frame >= 50 && frame <= 70) footY = 0.93;
    // Jump flight 71–100
    else if (frame > 70 && frame < 100) {
      const t = (frame - 70) / 30;
      footY = 0.9 - 0.35 * 4 * t * (1 - t);
    } else if (frame >= 100) footY = 0.92;
    out.push({ frame, footY, footX: 0.45, heelY: footY, heelX: 0.45 });
  }
  return out;
}

describe("penultimate detect", () => {
  it("finds penultimate contact before plant touchdown", () => {
    const marks = detectPenultimate(approachClip(), 50);
    expect(marks).not.toBeNull();
    expect(marks!.touchdown).toBeGreaterThanOrEqual(18);
    expect(marks!.touchdown).toBeLessThanOrEqual(25);
    expect(marks!.takeoff).toBeGreaterThanOrEqual(30);
    expect(marks!.takeoff).toBeLessThan(50);
  });

  it("returns null without a prior step", () => {
    const onlyPlant: FootSample[] = [];
    for (let frame = 0; frame <= 40; frame += 1) {
      onlyPlant.push({ frame, footY: frame < 10 ? 0.9 : frame < 25 ? 0.92 : 0.7 });
    }
    expect(detectPenultimate(onlyPlant, 10)).toBeNull();
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

  it("flags plant contact outside 120–400 ms", () => {
    expect(plantContactOutOfBand(200)).toBe(false);
    expect(plantContactOutOfBand(100)).toBe(true);
    expect(plantContactOutOfBand(450)).toBe(true);
    expect(plantContactOutOfBand(null)).toBe(false);
  });
});
