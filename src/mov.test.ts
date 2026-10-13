import { describe, expect, it } from "vitest";
import { IMG_0227_MOOV_BASE64 } from "./fixtures/img0227-moov.ts";
import { IMG_0227_FRAME_TIMES } from "./img0227-times.ts";
import { parseMovFrameTimes } from "./mov.ts";
import { alignClockToDuration, estimateBoxHeight } from "./timing.ts";

const moov = decodeBase64(IMG_0227_MOOV_BASE64);

describe("parseMovFrameTimes", () => {
  it("reads IMG_0227 composition times from the moov atom", () => {
    const times = parseMovFrameTimes(new Uint8Array(moov));
    expect(times).toEqual([...IMG_0227_FRAME_TIMES]);
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
