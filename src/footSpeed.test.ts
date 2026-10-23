import { describe, expect, it } from "vitest";
import {
  detectEvents,
  detectFootSpeedCycles,
  type FootSample,
  type FootSpeedTiming,
} from "./detect.ts";
import { validateCandidateRealTime } from "./resolveJumps.ts";

const BOX = 0.7;
const FLOOR = 0.9;

const timing240: FootSpeedTiming = { captureFps: 240, stretch: 1 };

/** Synthetic drop jump: on box → fall → contact → flight → land. */
function dropJump(td: number, to: number, ld: number, total: number): FootSample[] {
  const samples: FootSample[] = [];
  const stepOff = Math.max(0, td - 30);
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

function midDropJump(td: number, to: number, ld: number, total: number): FootSample[] {
  const samples: FootSample[] = [];
  for (let frame = 0; frame < total; frame += 1) {
    let footY: number;
    if (frame < td) {
      footY = BOX + 0.05 + ((FLOOR - 0.05 - (BOX + 0.05)) * frame) / Math.max(1, td);
    } else if (frame < to) footY = FLOOR;
    else if (frame < ld) {
      const t = (frame - to) / (ld - to);
      footY = FLOOR - 0.05 - 0.2 * 4 * t * (1 - t);
    } else footY = FLOOR;
    samples.push({ frame, footY });
  }
  return samples;
}

function twoJumpSet(): FootSample[] {
  const a = dropJump(80, 130, 230, 300);
  const b = dropJump(80, 130, 230, 300).map((s) => ({
    frame: s.frame + 320,
    footY: s.footY,
  }));
  const gap: FootSample[] = [];
  for (let frame = 300; frame < 320; frame += 1) gap.push({ frame, footY: FLOOR });
  return [...a, ...gap, ...b];
}

function withVisibilityNoise(samples: FootSample[], salt = 0.012): FootSample[] {
  return samples.map((s, i) => ({
    ...s,
    footY: s.footY + (((i * 17) % 7) - 3) * (salt / 3),
  }));
}

describe("foot-speed foot-strike detector", () => {
  it("finds touchdown / takeoff / landing on a drop jump", () => {
    const samples = dropJump(100, 160, 280, 400);
    const cycles = detectFootSpeedCycles(samples, timing240);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const c = cycles[0]!;
    expect(c.touchdown).toBeGreaterThanOrEqual(90);
    expect(c.touchdown).toBeLessThanOrEqual(110);
    expect(c.takeoff).toBeGreaterThanOrEqual(150);
    expect(c.takeoff).toBeLessThanOrEqual(175);
    expect(c.landing).toBeGreaterThanOrEqual(265);
    expect(c.landing).toBeLessThanOrEqual(295);
    expect(validateCandidateRealTime(c, timing240).ok).toBe(true);
  });

  it("finds a clip that starts mid-drop", () => {
    const samples = midDropJump(40, 90, 200, 320);
    const cycles = detectFootSpeedCycles(samples, timing240);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const c = cycles[0]!;
    expect(c.touchdown).toBeLessThanOrEqual(50);
    expect(c.takeoff).toBeGreaterThan(c.touchdown);
    expect(c.landing).toBeGreaterThan(c.takeoff);
    expect(validateCandidateRealTime(c, timing240).ok).toBe(true);
  });

  it("finds both cycles in a 2-jump set", () => {
    const samples = twoJumpSet();
    const cycles = detectFootSpeedCycles(samples, timing240, { maxJumps: 4 });
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    expect(cycles[0]!.landing).toBeLessThan(cycles[1]!.touchdown);
  });

  it("survives noisy visibility / footY jitter", () => {
    const samples = withVisibilityNoise(dropJump(100, 160, 280, 400), 0.018);
    const result = detectEvents(samples, undefined, 3, undefined, timing240);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.touchdown).toBeGreaterThanOrEqual(85);
    expect(result.events.touchdown).toBeLessThanOrEqual(120);
    expect(result.events.takeoff).toBeGreaterThan(result.events.touchdown);
    expect(result.events.landing).toBeGreaterThan(result.events.takeoff);
  });

  it("agrees with floor-contact detectEvents on a clean drop", () => {
    const samples = dropJump(100, 160, 280, 400);
    const result = detectEvents(samples, undefined, 3, undefined, timing240);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.touchdown).toBeGreaterThanOrEqual(95);
    expect(result.events.touchdown).toBeLessThanOrEqual(105);
    expect(result.events.takeoff).toBeGreaterThanOrEqual(155);
    expect(result.events.takeoff).toBeLessThanOrEqual(165);
    expect(result.events.landing).toBeGreaterThanOrEqual(275);
    expect(result.events.landing).toBeLessThanOrEqual(285);
  });
});
