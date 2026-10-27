import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  METRICS_BOTTOM_LIFT,
  OVERLAY,
  buildJumpOverlayModel,
  exportFrameHoldMs,
  exportReadyMediaVisibility,
  exportVideoFrameRange,
  findFlightApex,
  floorLevelNearTakeoff,
  heelAtFrame,
  heelPathDuringFlight,
  heelPathForApproach,
  heelTrailThrough,
  metricsStripRect,
  parseExportPlaybackSpeed,
  pickRecorderMime,
  recorderFormatNote,
} from "./jumpOverlay.ts";

function samples(): FootSample[] {
  const out: FootSample[] = [];
  for (let frame = 4; frame <= 40; frame += 1) {
    if (frame < 10) {
      out.push({ frame, footY: 0.9, footX: 0.42, heelY: 0.9, heelX: 0.42 });
      continue;
    }
    const t = (frame - 10) / 30;
    const footY = 0.9 - 0.4 * 4 * t * (1 - t);
    const heelY = footY - 0.01;
    out.push({ frame, footY, footX: 0.4 + t * 0.05, heelY, heelX: 0.4 + t * 0.05 });
  }
  return out;
}

describe("jumpOverlay heel trail", () => {
  it("builds a heel path and finds the apex", () => {
    const path = heelPathDuringFlight(samples(), 10, 40);
    expect(path.length).toBeGreaterThan(10);
    const apex = findFlightApex(path);
    expect(apex).not.toBeNull();
    expect(apex!.frame).toBeGreaterThan(15);
    expect(apex!.frame).toBeLessThan(35);

    const model = buildJumpOverlayModel(samples(), 10, 40, 22.5);
    expect(model).not.toBeNull();
    expect(model!.heightIn).toBe(22.5);
    expect(model!.heelPath.length).toBe(path.length);
    expect(model!.heelApex.frame).toBe(apex!.frame);
  });

  it("returns null without XY samples", () => {
    const bare: FootSample[] = [
      { frame: 10, footY: 0.9 },
      { frame: 20, footY: 0.5 },
      { frame: 30, footY: 0.9 },
    ];
    expect(buildJumpOverlayModel(bare, 10, 30, 12)).toBeNull();
  });

  it("grows the trail up to the current frame only", () => {
    const model = buildJumpOverlayModel(samples(), 10, 40, 21.5)!;
    const mid = heelTrailThrough(model.heelPath, 20);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.every((p) => p.frame <= 20)).toBe(true);
    expect(mid.length).toBeLessThan(model.heelPath.length);
    const at = heelAtFrame(model.heelPath, 20);
    expect(at!.frame).toBeLessThanOrEqual(20);
    expect(floorLevelNearTakeoff(samples(), 10)).toBeCloseTo(0.9, 2);
    expect(model.floorY).toBeCloseTo(0.9, 2);
  });

  it("keeps the build-s high-contrast palette (magenta / cyan / lime)", () => {
    expect(OVERLAY.heelDot.toLowerCase()).toBe("#ff2d95");
    expect(OVERLAY.trail.toLowerCase()).toBe("#00e5ff");
    expect(OVERLAY.apex.toLowerCase()).toBe("#c8ff00");
    expect(OVERLAY.heelDotOutline.toLowerCase()).toBe("#ffffff");
    expect(OVERLAY.trailOpacityMax).toBeLessThanOrEqual(0.4);
    expect(OVERLAY.trailOpacityMax).toBeGreaterThanOrEqual(0.35);
  });

  it("approach trail locks to one heel and rejects foot-switch outliers", () => {
    const zigzag: FootSample[] = [];
    for (let frame = 90; frame <= 140; frame += 1) {
      // Smooth right-heel plant path…
      const t = (frame - 100) / 40;
      const ry = 0.9 - 0.35 * 4 * Math.max(0, Math.min(1, t)) * (1 - Math.max(0, Math.min(1, t)));
      const rx = 0.55 + t * 0.02;
      // …plus left-heel outliers across the frame
      zigzag.push({
        frame,
        footY: ry,
        footX: rx,
        heelY: ry,
        heelX: rx,
        rightHeelX: rx,
        rightHeelY: ry,
        leftHeelX: frame % 5 === 0 ? 0.15 : 0.52,
        leftHeelY: frame % 5 === 0 ? 0.4 : ry,
        heelVis: 0.8,
      });
    }
    const path = heelPathForApproach(zigzag, 100, 110, 140);
    expect(path.length).toBeGreaterThan(8);
    const xs = path.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.2);
    const model = buildJumpOverlayModel(zigzag, 110, 140, 25, {
      approach: true,
      plantTouchdown: 100,
    });
    expect(model).not.toBeNull();
    expect(model!.heelPath[0]!.frame).toBeGreaterThanOrEqual(90);
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
    expect(recorderFormatNote("mp4")).toMatch(/MP4/i);
    expect(recorderFormatNote("webm")).toMatch(/WebM/i);
  });

  it("shows only one export preview at a time (card XOR video)", () => {
    expect(exportReadyMediaVisibility("image")).toEqual({ showVideo: false, showImage: true });
    expect(exportReadyMediaVisibility("video")).toEqual({ showVideo: true, showImage: false });
  });

  it("lifts the cream metrics strip ~9% from the bottom (pre-t style)", () => {
    const h = 1280;
    const w = 720;
    const strip = metricsStripRect(w, h);
    expect(METRICS_BOTTOM_LIFT).toBeCloseTo(0.09, 5);
    expect(h - (strip.y + strip.h)).toBeCloseTo(h * METRICS_BOTTOM_LIFT, 5);
    expect(strip.h).toBe(Math.max(96, Math.round(w * 0.18)));
    expect(strip.y).toBeGreaterThan(0);
  });
});
