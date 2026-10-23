import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import {
  buildJumpOverlayModel,
  findFlightApex,
  footPathDuringFlight,
} from "./jumpOverlay.ts";

function samples(): FootSample[] {
  const out: FootSample[] = [];
  // Takeoff 10 → apex ~25 (high in frame = low Y) → landing 40
  for (let frame = 10; frame <= 40; frame += 1) {
    const t = (frame - 10) / 30;
    const y = 0.85 - 0.35 * 4 * t * (1 - t); // parabola up then down
    out.push({ frame, footY: y, footX: 0.4 + t * 0.05 });
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
    expect(model!.apexFrame).toBe(apex!.frame);
  });

  it("returns null without XY samples", () => {
    const bare: FootSample[] = [
      { frame: 10, footY: 0.9 },
      { frame: 20, footY: 0.5 },
      { frame: 30, footY: 0.9 },
    ];
    expect(buildJumpOverlayModel(bare, 10, 30, 12)).toBeNull();
  });
});
