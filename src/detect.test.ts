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
    expect(result.events.touchdown).toBeGreaterThanOrEqual(98);
    expect(result.events.touchdown).toBeLessThanOrEqual(102);
    expect(result.events.takeoff).toBeGreaterThanOrEqual(158);
    expect(result.events.takeoff).toBeLessThanOrEqual(162);
    expect(result.events.landing).toBe(280);
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
    expect(result.ok && result.events.takeoff).toBeGreaterThanOrEqual(158);
    expect(result.ok && result.events.takeoff).toBeLessThanOrEqual(162);
  });

  it("matches a full-rate pass when coarse samples are refined", () => {
    const full = jump(101, 163, 279, 400);
    const coarse = coarseFrames(400, 4).map((frame) => full[frame]);
    const first = detectEvents(coarse);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const extra = refineFrames(first.events, 4, 400).map((frame) => full[frame]);
    const refined = detectEvents([...coarse, ...extra], first.model);
    expect(refined.ok && refined.events.touchdown).toBeGreaterThanOrEqual(99);
    expect(refined.ok && refined.events.touchdown).toBeLessThanOrEqual(103);
    expect(refined.ok && refined.events.takeoff).toBeGreaterThanOrEqual(161);
    expect(refined.ok && refined.events.takeoff).toBeLessThanOrEqual(165);
    expect(refined.ok && refined.events.landing).toBe(279);
  });

  it("finds the last frame on the box", () => {
    // In jump(), frame td - 30 is the last frame at box level.
    const result = detectEvents(jump(100, 160, 280, 400));
    expect(result.ok && result.events.stepOff).toBeGreaterThanOrEqual(70);
    expect(result.ok && result.events.stepOff).toBeLessThanOrEqual(71);
  });

  it("uses the trailing foot for step-off when both feet are visible", () => {
    const samples = jump(100, 160, 280, 400).map((sample) =>
      sample.frame >= 60 && sample.frame < 70 ? { ...sample, footY: 0.8, upperFootY: BOX } : sample,
    );
    const result = detectEvents(samples);
    expect(result.ok && result.events.stepOff).toBeGreaterThanOrEqual(70);
  });

  it("refines step-off from coarse samples", () => {
    const full = jump(101, 163, 279, 400);
    const coarse = coarseFrames(400, 4).map((frame) => full[frame]);
    const first = detectEvents(coarse);
    if (!first.ok) throw new Error(first.reason);
    const extra = refineFrames(first.events, 4, 400).map((frame) => full[frame]);
    const refined = detectEvents([...coarse, ...extra], first.model);
    const full240 = detectEvents(full);
    expect(refined.ok && refined.events.stepOff).toBe(full240.ok && full240.events.stepOff);
  });

  it("has no step-off when there is no box level", () => {
    const samples = jump(100, 160, 280, 400).map((sample) =>
      sample.frame < 100 ? { ...sample, footY: FLOOR - 0.01 } : sample,
    );
    const result = detectEvents(samples);
    if (result.ok) expect(result.events.stepOff).toBeNull();
  });

  it("reports a reason when there is no landing", () => {
    const samples = jump(100, 160, 280, 250);
    const result = detectEvents(samples);
    expect(result.ok).toBe(false);
  });

  it("needs enough samples", () => {
    expect(groundModel([{ frame: 0, footY: 0.5 }])).toBeNull();
  });

  it("finds a jump that starts mid-drop at frame 0 (no standing before)", () => {
    // Recording begins already falling; touchdown at 40, takeoff 90, landing 200.
    const samples: FootSample[] = [];
    for (let frame = 0; frame < 320; frame += 1) {
      let footY: number;
      if (frame < 40) {
        footY = BOX + 0.05 + ((FLOOR - 0.05 - (BOX + 0.05)) * frame) / 40;
      } else if (frame < 90) footY = FLOOR;
      else if (frame < 200) {
        const t = (frame - 90) / 110;
        footY = FLOOR - 0.05 - 0.2 * 4 * t * (1 - t);
      } else footY = FLOOR;
      samples.push({ frame, footY });
    }
    const result = detectEvents(samples);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.touchdown).toBe(40);
    expect(result.events.takeoff).toBe(90);
    expect(result.events.landing).toBe(200);
  });

  it("ignores heel rise while toes stay planted (takeoff = toe-off)", () => {
    // Heels lift ~12 frames before toes leave the floor; landing has a late still.
    const samples: FootSample[] = [];
    const td = 100;
    const heelRise = 149;
    const toeOff = 161;
    const firstLand = 259;
    const lateStill = 347;
    for (let frame = 0; frame < 360; frame += 1) {
      let footY: number; // ankle/heel
      let toeY: number;
      if (frame < td - 30) {
        footY = BOX;
        toeY = BOX + 0.02;
      } else if (frame < td) {
        const t = (frame - (td - 30)) / 30;
        footY = BOX + (FLOOR - BOX) * t;
        toeY = footY + 0.01;
      } else if (frame < heelRise) {
        footY = FLOOR;
        toeY = FLOOR + 0.01;
      } else if (frame < toeOff) {
        footY = FLOOR - 0.06; // heel up
        toeY = FLOOR + 0.01; // toe still down
      } else if (frame < firstLand) {
        const t = (frame - toeOff) / (firstLand - toeOff);
        footY = FLOOR - 0.05 - 0.22 * 4 * t * (1 - t);
        toeY = footY - 0.01;
      } else if (frame < lateStill) {
        footY = FLOOR - 0.03; // soft rebound / not fully still
        toeY = FLOOR + 0.005;
      } else {
        footY = FLOOR;
        toeY = FLOOR + 0.01;
      }
      samples.push({ frame, footY, leftToeY: toeY, rightToeY: toeY });
    }
    const result = detectEvents(samples);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.takeoff).toBeGreaterThanOrEqual(toeOff - 3);
    expect(result.events.takeoff).toBeLessThanOrEqual(toeOff + 3);
    expect(result.events.landing).toBeGreaterThanOrEqual(firstLand - 3);
    expect(result.events.landing).toBeLessThanOrEqual(firstLand + 3);
    expect(result.events.landing).toBeLessThan(lateStill - 20);
  });

  it("finds a mid-drop jump from a hip/knee proxy signal (dark feet)", () => {
    const samples: FootSample[] = [];
    for (let frame = 0; frame < 320; frame += 1) {
      // Hip-like signal: lower in frame when standing, rises in flight.
      let hipY: number;
      if (frame < 40) hipY = 0.55 + (0.12 * frame) / 40;
      else if (frame < 90) hipY = 0.72;
      else if (frame < 200) {
        const t = (frame - 90) / 110;
        hipY = 0.72 - 0.22 * 4 * t * (1 - t);
      } else hipY = 0.72;
      const footY = Math.min(0.98, hipY + 0.28);
      samples.push({ frame, footY, hipY });
    }
    const result = detectEvents(samples);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.touchdown).toBeLessThan(60);
    expect(result.events.takeoff).toBeGreaterThan(result.events.touchdown);
    expect(result.events.landing).toBeGreaterThan(result.events.takeoff);
  });
});
