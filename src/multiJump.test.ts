import { describe, expect, it } from "vitest";
import { detectAllEvents, type FootSample } from "./detect.ts";
import {
  buildMultiJumpRows,
  createSetId,
  jumpInSlowedSection,
  scanStep,
  slowedRegions,
  summarizeSet,
} from "./multiJump.ts";
import img0228Pts from "./fixtures/img0228-pts.json";

const BOX = 0.7;
const FLOOR = 0.9;

function oneJump(td: number, to: number, ld: number, from: number, toFrame: number): FootSample[] {
  const samples: FootSample[] = [];
  const stepOff = td - 30;
  for (let frame = from; frame < toFrame; frame += 1) {
    let footY: number;
    if (frame < stepOff) footY = BOX;
    else if (frame < td) footY = BOX + ((FLOOR - 0.05 - BOX) * (frame - stepOff)) / Math.max(1, td - stepOff);
    else if (frame < to) footY = FLOOR;
    else if (frame < ld) {
      const t = (frame - to) / Math.max(1, ld - to);
      footY = FLOOR - 0.05 - 0.2 * 4 * t * (1 - t);
    } else footY = FLOOR;
    samples.push({ frame, footY });
  }
  return samples;
}

describe("multi-jump segmentation", () => {
  it("finds three jumps split by standing periods", () => {
    const samples = [
      ...oneJump(80, 120, 200, 0, 260),
      ...oneJump(340, 380, 460, 260, 520),
      ...oneJump(600, 640, 720, 520, 780),
    ];
    const result = detectAllEvents(samples, { minStandFrames: 20, maxJumps: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jumps).toHaveLength(3);
    expect(result.jumps.map((j) => j.touchdown)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(result.jumps[0]!.touchdown).toBeGreaterThanOrEqual(78);
    expect(result.jumps[0]!.touchdown).toBeLessThanOrEqual(82);
    expect(result.jumps[1]!.touchdown).toBeGreaterThanOrEqual(338);
    expect(result.jumps[2]!.touchdown).toBeGreaterThanOrEqual(598);
  });

  it("keeps single-jump detectEvents behavior", () => {
    const samples = oneJump(100, 160, 280, 0, 400);
    const multi = detectAllEvents(samples, { maxJumps: 1 });
    expect(multi.ok && multi.jumps).toHaveLength(1);
  });

  it("does not require a pre-jump stand for the first cycle (mid-drop start)", () => {
    const samples = oneJump(40, 90, 200, 0, 320).filter((s) => s.frame >= 0);
    // Strip the on-box lead-in: keep only mid-fall onward.
    const mid = samples.filter((s) => s.frame >= 10);
    const multi = detectAllEvents(mid, { maxJumps: 2, minStandFrames: 12 });
    expect(multi.ok).toBe(true);
    if (!multi.ok) return;
    expect(multi.jumps.length).toBeGreaterThanOrEqual(1);
    expect(multi.jumps[0]!.touchdown).toBeGreaterThanOrEqual(40);
  });
});

describe("slowed regions from IMG_0228 pts", () => {
  it("treats the held slo-mo clip as one slowed region", () => {
    const times = img0228Pts as number[];
    expect(times).toHaveLength(2927);
    const regions = slowedRegions(times);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]!.startFrame).toBe(0);
    expect(regions[0]!.endFrame).toBe(times.length - 1);
    expect(
      jumpInSlowedSection(
        { stepOff: 100, touchdown: 200, takeoff: 260, landing: 400 },
        regions,
      ),
    ).toBe(true);
  });

  it("flags a jump outside a synthetic slow window", () => {
    const regions = [{ startFrame: 0, endFrame: 100, startTime: 0, endTime: 2 }];
    expect(
      jumpInSlowedSection({ stepOff: null, touchdown: 200, takeoff: 240, landing: 300 }, regions),
    ).toBe(false);
  });
});

describe("set summary + scan step", () => {
  it("summarizes included jumps", () => {
    const rows = buildMultiJumpRows(
      [
        { stepOff: 10, touchdown: 40, takeoff: 80, landing: 160 },
        { stepOff: 200, touchdown: 240, takeoff: 280, landing: 360 },
      ],
      undefined,
      170,
      4,
    );
    rows[1]!.include = false;
    const summary = summarizeSet(rows);
    expect(summary.count).toBe(1);
    expect(createSetId(new Date("2026-10-14T12:00:00")).startsWith("set-")).toBe(true);
    expect(scanStep(2927)).toBeGreaterThan(1);
  });
});
