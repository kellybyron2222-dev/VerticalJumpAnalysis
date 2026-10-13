import { describe, expect, it } from "vitest";
import { coarseFrames, detectEvents, groundModel, refineFrames, type FootSample } from "./detect.ts";

const BOX = 0.7;
const FLOOR = 0.9;

/** Synthetic drop jump: on box, fall, contact, flight, land. */
function jump(td: number, to: number, ld: number, total: number): FootSample[] {
  const samples: FootSample[] = [];
  const stepOff = td - 30;
  for (let frame = 0; frame < total; frame += 1) {
    let footY: number;
    if (frame < stepOff) footY = BOX;
    else if (frame < td) footY = BOX + ((FLOOR - 0.05 - BOX) * (frame - stepOff)) / (td - stepOff);
    else if (frame < to) footY = FLOOR;
    else if (frame < ld) {
      const t = (frame - to) / (ld - to);
      footY = FLOOR - 0.05 - 0.2 * 4 * t * (1 - t);
    } else footY = FLOOR;
    samples.push({ frame, footY });
  }
  return samples;
}

describe("detectEvents", () => {
  it("finds touchdown, takeoff, and landing at the first frame of each state", () => {
    const result = detectEvents(jump(100, 160, 280, 400));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual({ touchdown: 100, takeoff: 160, landing: 280 });
  });

  it("gives identical marks for identical input", () => {
    const samples = jump(90, 140, 250, 360);
    const a = detectEvents(samples);
    const b = detectEvents([...samples].reverse());
    expect(a).toEqual(b);
  });

  it("ignores a short noise blip during contact", () => {
    const samples = jump(100, 160, 280, 400);
    samples[120] = { frame: 120, footY: FLOOR - 0.1 };
    const result = detectEvents(samples);
    expect(result.ok && result.events.takeoff).toBe(160);
  });

  it("matches a full-rate pass when coarse samples are refined", () => {
    const full = jump(101, 163, 279, 400);
    const coarse = coarseFrames(400, 4).map((frame) => full[frame]);
    const first = detectEvents(coarse);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const extra = refineFrames(first.events, 4, 400).map((frame) => full[frame]);
    const refined = detectEvents([...coarse, ...extra], first.model);
    expect(refined.ok && refined.events).toEqual({ touchdown: 101, takeoff: 163, landing: 279 });
  });

  it("reports a reason when there is no landing", () => {
    const samples = jump(100, 160, 280, 250);
    const result = detectEvents(samples);
    expect(result.ok).toBe(false);
  });

  it("needs enough samples", () => {
    expect(groundModel([{ frame: 0, footY: 0.5 }])).toBeNull();
  });
});
