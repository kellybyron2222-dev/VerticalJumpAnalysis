import { describe, expect, it } from "vitest";
import { IMG_0227_MOOV_BASE64 } from "./fixtures/img0227-moov.ts";
import { IMG_0227_FRAME_TIMES } from "./img0227-times.ts";
import { computeTrialMetrics } from "./metrics.ts";
import { parseMovFrameTimes } from "./mov.ts";
import { alignClockToDuration, estimateBoxHeight } from "./timing.ts";

const moov = decodeBase64(IMG_0227_MOOV_BASE64);

describe("parseMovFrameTimes", () => {
  it("reads IMG_0227 from the moov atom and keeps the 5.5 in box", () => {
    const times = parseMovFrameTimes(new Uint8Array(moov));
    expect(times).toEqual([...IMG_0227_FRAME_TIMES]);
    const stepOff = 45;
    const touchdown = 52;
    const takeoff = 76;
    const landing = 94;
    const box = estimateBoxHeight(stepOff, touchdown, 60, 1, times!);
    const jump = computeTrialMetrics({
      touchdown,
      takeoff,
      landing,
      fps: 60,
      slowMoFactor: 1,
      frameTimes: times!,
    });
    expect(box!.heightIn).toBeGreaterThan(5);
    expect(box!.heightIn).toBeLessThan(6);
    expect(jump!.gctMs).toBeGreaterThan(520);
    expect(jump!.gctMs).toBeLessThan(620);
    expect(jump!.flightMs).toBeGreaterThan(350);
    expect(jump!.flightMs).toBeLessThan(420);
    expect(jump!.heightIn).toBeGreaterThan(6);
    expect(jump!.heightIn).toBeLessThan(9);
  });

  it("shifts a pre-edit mediaTime clock without changing the box", () => {
    const shifted = IMG_0227_FRAME_TIMES.map((time) => time + 2.101667);
    const aligned = alignClockToDuration(shifted, 4);
    expect(aligned).not.toBeNull();
    expect(aligned![0]).toBeCloseTo(0, 5);
    expect(aligned![aligned!.length - 1]).toBeLessThan(4);
    const fromFile = estimateBoxHeight(45, 52, 60, 1, IMG_0227_FRAME_TIMES);
    const fromShifted = estimateBoxHeight(45, 52, 60, 1, aligned!);
    expect(fromShifted!.heightIn).toBeCloseTo(fromFile!.heightIn, 4);
    expect(fromShifted!.heightIn).toBeCloseTo(5.5, 0);
  });
});

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
