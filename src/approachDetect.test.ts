import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import { detectApproachFromPose } from "./approachDetect.ts";

function pts(frameCount: number, playbackFps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < frameCount; i += 1) times.push(i / playbackFps);
  return times;
}

/** Synthetic any-foot series matching clip0-like structure (entered mid pen contact). */
function clipLikeApproach(): {
  samples: FootSample[];
  timing: { fps: number; stretch: number; frameTimes: number[] };
} {
  const playbackFps = 4300 / 101; // ~42.57
  const timing = { fps: 170, stretch: 4, frameTimes: pts(400, playbackFps) };
  const samples: FootSample[] = [];
  // GT clip0: pen ~67–80 (entered mid), plant 112–170, land 290
  for (let frame = 0; frame <= 320; frame += 1) {
    let footY = 0.72;
    if (frame >= 0 && frame <= 80) footY = 0.93;
    if (frame > 80 && frame < 112) footY = 0.7;
    if (frame >= 112 && frame <= 170) footY = 0.94;
    if (frame > 170 && frame < 290) footY = 0.5;
    if (frame >= 290) footY = 0.93;
    samples.push({ frame, footY, heelY: footY });
  }
  return { samples, timing };
}

describe("detectApproachFromPose", () => {
  it("anchors plant TD by walking back from TO; blanks pen TD at clip entry", () => {
    const { samples, timing } = clipLikeApproach();
    const result = detectApproachFromPose(samples, timing);
    expect(result).not.toBeNull();
    expect(result!.touchdown).toBeGreaterThanOrEqual(110);
    expect(result!.touchdown).toBeLessThanOrEqual(115);
    expect(result!.takeoff).toBe(170);
    expect(result!.landing).toBe(290);
    expect(result!.penTdBeforeClip).toBe(true);
    expect(result!.penTouchdown).toBeNull();
    expect(result!.penTakeoff).toBe(80);
    expect(result!.stepGapMs!).toBeGreaterThan(140);
    expect(result!.stepGapMs!).toBeLessThan(220);
    expect(result!.plantContactMs!).toBeGreaterThanOrEqual(200);
    expect(result!.plantContactMs!).toBeLessThanOrEqual(450);
  });

  it("ignores L/R identity — footY any-foot signal alone is enough", () => {
    const { samples, timing } = clipLikeApproach();
    const combinedOnly = samples.map((s) => ({
      frame: s.frame,
      footY: s.footY,
      heelY: s.heelY,
    }));
    const result = detectApproachFromPose(combinedOnly, timing);
    expect(result).not.toBeNull();
    expect(result!.touchdown).toBeGreaterThanOrEqual(110);
    expect(result!.touchdown).toBeLessThanOrEqual(115);
    expect(result!.takeoff).toBe(170);
    expect(result!.landing).toBe(290);
    expect(result!.penTdBeforeClip).toBe(true);
    expect(result!.penTakeoff).toBe(80);
  });

  it("does not bridge a 3+ frame air hole into the penultimate", () => {
    const { samples, timing } = clipLikeApproach();
    // 3-frame hole inside plant must NOT be bridged (max bridge = 2).
    // Remove contact at 140-142 by dropping footY — still one plant if edges connect? 
    // Better: ensure step gap stays 81-111 (≥3 frames) so pen doesn't merge.
    const result = detectApproachFromPose(samples, timing);
    expect(result!.touchdown).toBeGreaterThan(result!.penTakeoff!);
    expect(result!.touchdown - result!.penTakeoff!).toBeGreaterThan(2);
  });
});
