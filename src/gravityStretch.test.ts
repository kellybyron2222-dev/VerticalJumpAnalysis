import { describe, expect, it } from "vitest";
import type { FootSample } from "./detect.ts";
import { gravityStretch, isAmbiguousSloMo } from "./gravityStretch.ts";

const G = 9.80665;
const REF_LEG_M = 0.7;

/** Flat ~30 fps media clock for N frames. */
function flatClock(n: number, fps = 30): number[] {
  return Array.from({ length: n }, (_, i) => i / fps);
}

/** Variable-rate clock (1/60 + 1/30 holds). */
function variableClock(n: number): number[] {
  const times = [0];
  for (let i = 1; i < n; i += 1) {
    times.push(times[i - 1]! + (i % 2 === 0 ? 1 / 30 : 1 / 60));
  }
  return times;
}

/**
 * Synthetic pose: standing leg length REF_LEG_M, flight parabola in real time
 * with capture stretch `k` onto a flat 30 fps media clock.
 */
function synthJump(k: number): { samples: FootSample[]; times: number[]; to: number; ld: number } {
  const mediaFps = 30;
  const captureFps = 30 * k;
  const to = 40;
  const flightRealS = 0.55; // ~apex height ~0.37 m
  const flightFrames = Math.round(flightRealS * captureFps);
  const ld = to + flightFrames;
  const total = ld + 40;
  const times = flatClock(total, mediaFps);
  const unitsPerM = 0.4 / REF_LEG_M; // ~0.57 norm units per meter
  const standHip = 0.55;
  const standFoot = standHip + REF_LEG_M * unitsPerM;
  const samples: FootSample[] = [];
  for (let f = 0; f < total; f += 1) {
    let hipY: number;
    let footY: number;
    if (f < to || f > ld) {
      hipY = standHip;
      footY = standFoot;
    } else {
      const tReal = (f - to) / captureFps;
      const tApex = flightRealS / 2;
      const dy = 0.5 * G * (tReal - tApex) ** 2 - 0.5 * G * tApex ** 2;
      // Image y: up is smaller. Apex is highest → smallest hipY.
      hipY = standHip + dy * unitsPerM;
      footY = hipY - 0.05; // feet tucked
    }
    samples.push({ frame: f, footY, hipY });
  }
  return { samples, times, to, ld };
}

describe("isAmbiguousSloMo", () => {
  it("is true only with Apple slo-mo flag and a flat ~30 clock", () => {
    const flat = flatClock(60, 30);
    expect(isAmbiguousSloMo(flat, { slowMoPlayback: true })).toBe(true);
  });

  it("is false without the slo-mo flag", () => {
    expect(isAmbiguousSloMo(flatClock(60, 30), { slowMoPlayback: false })).toBe(false);
    expect(isAmbiguousSloMo(flatClock(60, 30), {})).toBe(false);
  });

  it("is false on a variable-rate clock even with the flag", () => {
    expect(isAmbiguousSloMo(variableClock(60), { slowMoPlayback: true })).toBe(false);
  });
});

describe("gravityStretch", () => {
  it("picks 4× for synthetic 120 fps on a flat 30 clock", () => {
    const { samples, times, to, ld } = synthJump(4);
    const g = gravityStretch(samples, to, ld, times);
    expect(g).not.toBeNull();
    expect(g!.stretch).toBe(4);
  });

  it("picks 8× for synthetic 240 fps on a flat 30 clock", () => {
    const { samples, times, to, ld } = synthJump(8);
    const g = gravityStretch(samples, to, ld, times);
    expect(g).not.toBeNull();
    expect(g!.stretch).toBe(8);
  });
});
