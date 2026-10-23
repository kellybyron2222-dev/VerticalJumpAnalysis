import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  buildJumpOverlayModel,
  exportFrameHoldMs,
  exportVideoFrameRange,
  findFlightApex,
  findHipApex,
  footPathDuringFlight,
  parseExportPlaybackSpeed,
  pickRecorderMime,
} from "./jumpOverlay.ts";

function samples(): FootSample[] {
  const out: FootSample[] = [];
  // Takeoff 10 → apex ~25 (high in frame = low Y) → landing 40
  for (let frame = 10; frame <= 40; frame += 1) {
    const t = (frame - 10) / 30;
    const footY = 0.85 - 0.35 * 4 * t * (1 - t); // parabola up then down
    const hipY = footY - 0.28 - 0.08 * 4 * t * (1 - t);
    out.push({ frame, footY, footX: 0.4 + t * 0.05, hipY });
  }
  return out;
}

describe("jumpOverlay foot path", () => {
  it("builds a flight path and finds the apex", () => {
    const path = footPathDuringFlight(samples(), 10, 40);
    expect(path.length).toBeGreaterThan(10);
    const apex = findFlightApex(path);
    expect(apex).not.toBeNull();
    expect(apex!.frame).toBeGreaterThan(15);
    expect(apex!.frame).toBeLessThan(35);
    expect(apex!.y).toBeLessThan(0.6);

    const model = buildJumpOverlayModel(samples(), 10, 40, 22.5);
    expect(model).not.toBeNull();
    expect(model!.heightIn).toBe(22.5);
    expect(model!.apex.frame).toBe(apex!.frame);
  });

  it("returns null without XY samples", () => {
    const bare: FootSample[] = [
      { frame: 10, footY: 0.9 },
      { frame: 20, footY: 0.5 },
      { frame: 30, footY: 0.9 },
    ];
    expect(buildJumpOverlayModel(bare, 10, 30, 12)).toBeNull();
  });

  it("stores takeoff and hip-apex for CoM height bracket", () => {
    const model = buildJumpOverlayModel(samples(), 10, 40, 21.5);
    expect(model).not.toBeNull();
    expect(model!.takeoffHipY).not.toBeNull();
    expect(model!.apexHipY).not.toBeNull();
    expect(model!.apexHipY!).toBeLessThan(model!.takeoffHipY!);
    const hip = findHipApex(samples(), 10, 40);
    expect(hip).not.toBeNull();
    expect(model!.apexFrame).toBe(hip!.frame);
    expect(model!.bracketX).toBeGreaterThan(model!.apex.x);
  });
});

describe("jump video export helpers", () => {
  it("covers step-off through a pad after landing", () => {
    expect(exportVideoFrameRange(5, 10, 40, 100, 8)).toEqual({ start: 5, end: 48 });
    expect(exportVideoFrameRange(null, 10, 40, 42, 8)).toEqual({ start: 8, end: 41 });
  });

  it("scales frame holds for watchable slow-mo", () => {
    expect(exportFrameHoldMs(0.01, 1)).toBeCloseTo(10, 5);
    expect(exportFrameHoldMs(0.01, 0.25)).toBeCloseTo(40, 5);
    expect(parseExportPlaybackSpeed("0.5")).toBe(0.5);
    expect(parseExportPlaybackSpeed("nope")).toBe(0.25);
  });

  it("pickRecorderMime returns a usable shape", () => {
    const picked = pickRecorderMime();
    expect(picked.ext === "mp4" || picked.ext === "webm").toBe(true);
  });
});
