import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import { detectApproachFromPose } from "./approachDetect.ts";

function pts(frameCount: number, playbackFps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < frameCount; i += 1) times.push(i / playbackFps);
  return times;
}

/** Synthetic any-foot series matching clip0-like structure (entered mid pen contact). */
function clipLikeApproach(): { samples: FootSample[]; timing: { fps: number; stretch: number; frameTimes: number[] } } {
  // Use GT-like spacing: media ≈ 42.57 fps, stretch 4 → real ≈ 170 mean / 240 median.
  const playbackFps = 4300 / 101; // ~42.57
  const timing = { fps: 170, stretch: 4, frameTimes: pts(400, playbackFps) };
  const samples: FootSample[] = [];
  // GT clip0: pen ~67–80 (entered mid), plant 112–170, land 290
  for (let frame = 0; frame <= 320; frame += 1) {
    let footY = 0.72; // air / stand high
    if (frame >= 0 && frame <= 80) footY = 0.93; // pen already down at entry
    if (frame > 80 && frame < 112) footY = 0.7; // step gap
    if (frame >= 112 && frame <= 170) footY = 0.94; // plant (lead then trail)
    if (frame > 170 && frame < 290) footY = 0.5; // flight
    if (frame >= 290) footY = 0.93; // land
    samples.push({ frame, footY, heelY: footY });
  }
  return { samples, timing };
}

describe("detectApproachFromPose", () => {
  it("finds plant TD/TO/LD and blanks pen TD when entered mid-contact", () => {
    const { samples, timing } = clipLikeApproach();
    const result = detectApproachFromPose(samples, timing);
    expect(result).not.toBeNull();
    expect(result!.touchdown).toBe(112);
    expect(result!.takeoff).toBe(170);
    expect(result!.landing).toBe(290);
    expect(result!.penTdBeforeClip).toBe(true);
    expect(result!.penTouchdown).toBeNull();
    expect(result!.penTakeoff).toBe(80);
    expect(result!.stepGapMs!).toBeGreaterThan(100);
    expect(result!.stepGapMs!).toBeLessThan(250);
    expect(result!.plantContactMs!).toBeGreaterThan(250);
    expect(result!.flightMs!).toBeGreaterThan(500);
  });

  it("ignores L/R identity — footY any-foot signal alone is enough", () => {
    const { samples, timing } = clipLikeApproach();
    // Only combined footY (no L/R) — must still detect plant.
    const combinedOnly = samples.map((s) => ({
      frame: s.frame,
      footY: s.footY,
      heelY: s.heelY,
    }));
    const result = detectApproachFromPose(combinedOnly, timing);
    expect(result).not.toBeNull();
    expect(result!.touchdown).toBe(112);
    expect(result!.takeoff).toBe(170);
    expect(result!.landing).toBe(290);
    expect(result!.penTdBeforeClip).toBe(true);
    expect(result!.penTakeoff).toBe(80);
  });
});
