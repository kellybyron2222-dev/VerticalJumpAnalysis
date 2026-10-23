import { describe, expect, it } from "vitest";
import type { DetectCandidate } from "./detectDiag.ts";
import {
  cyclesSeparated,
  mergeFragmentCandidates,
  resolveJumpSet,
  validateCandidateRealTime,
} from "./resolveJumps.ts";

/** Presentation clock ~52 fps (422 frames ≈ 8.1 s media); stretch 4 → real time. */
function ptsClock(frameCount: number, playbackFps = 52): number[] {
  const times: number[] = [];
  for (let i = 0; i < frameCount; i += 1) times.push(i / playbackFps);
  return times;
}

const timing207 = {
  captureFps: 207,
  stretch: 4,
  frameTimes: ptsClock(400, 52),
};

/** Byron clip #3 fragments (exact). */
const candidateA: DetectCandidate = {
  stepOff: 154,
  touchdown: 155,
  takeoff: 157,
  landing: 296,
  score: 32.9,
  note: "A",
};
const candidateB: DetectCandidate = {
  stepOff: 105,
  touchdown: 123,
  takeoff: 141,
  landing: 145,
  score: 25.7,
  note: "B",
};

describe("real-time candidate validation", () => {
  it("rejects Byron A (2-frame contact) and B (4-frame flight)", () => {
    const a = validateCandidateRealTime(candidateA, timing207);
    const b = validateCandidateRealTime(candidateB, timing207);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.reason).toMatch(/contact/i);
    expect(b.reason).toMatch(/flight/i);
  });

  it("accepts a plausible cycle", () => {
    // ~200 ms contact, ~500 ms flight at 52 fps / 4×
    const c: DetectCandidate = {
      stepOff: 80,
      touchdown: 120,
      takeoff: 160, // 40 frames ≈ 192 ms real
      landing: 260, // 100 frames ≈ 481 ms real
      score: 40,
    };
    expect(validateCandidateRealTime(c, timing207).ok).toBe(true);
  });
});

describe("Byron #3 regression — fragments become one jump", () => {
  it("merges A+B into a single jump, never two", () => {
    const resolved = resolveJumpSet([candidateA, candidateB], timing207, { stepOffHint: 87 });
    expect(resolved.jumps).toHaveLength(1);
    const jump = resolved.jumps[0]!;
    // First sustained contact after free-fall (~TD 123), main flight from A.
    expect(jump.touchdown).toBeLessThanOrEqual(123);
    expect(jump.takeoff).toBeGreaterThanOrEqual(155);
    expect(jump.landing).toBeGreaterThanOrEqual(296);
    expect(jump.touchdown).toBeLessThan(jump.takeoff);
    expect(jump.takeoff).toBeLessThan(jump.landing);
    const check = validateCandidateRealTime(
      { ...jump, score: 0, note: "merged" },
      timing207,
    );
    expect(check.ok).toBe(true);
  });

  it("mergeFragmentCandidates picks longest flight", () => {
    const merged = mergeFragmentCandidates([candidateA, candidateB], 87);
    expect(merged).not.toBeNull();
    expect(merged!.touchdown).toBe(123);
    expect(merged!.takeoff).toBe(157);
    expect(merged!.landing).toBe(296);
    expect(merged!.stepOff).toBe(87);
  });
});

describe("real two-jump set still splits", () => {
  it("keeps two separated valid cycles", () => {
    // Jump 1 then standing then jump 2 — all in real-time budget.
    const j1: DetectCandidate = {
      stepOff: 40,
      touchdown: 80,
      takeoff: 120,
      landing: 220,
      score: 40,
    };
    const j2: DetectCandidate = {
      stepOff: 300,
      touchdown: 340,
      takeoff: 380,
      landing: 480,
      score: 40,
    };
    const clock = ptsClock(600, 52);
    const timing = { captureFps: 207, stretch: 4, frameTimes: clock };
    expect(validateCandidateRealTime(j1, timing).ok).toBe(true);
    expect(validateCandidateRealTime(j2, timing).ok).toBe(true);
    expect(cyclesSeparated(j1, j2, timing)).toBe(true);
    const resolved = resolveJumpSet([j1, j2], timing);
    expect(resolved.jumps).toHaveLength(2);
    expect(resolved.jumps[0]!.touchdown).toBe(80);
    expect(resolved.jumps[1]!.touchdown).toBe(340);
  });
});

describe("Byron false second jump (settling after one drop)", () => {
  /** Exact candidates from build 2026-10-23e heavy-model clip. */
  const byronA: DetectCandidate = {
    stepOff: 60,
    touchdown: 86,
    takeoff: 122,
    landing: 266,
    score: 38.3,
    note: "foot-speed ok",
  };
  const byronB: DetectCandidate = {
    stepOff: 365,
    touchdown: 366,
    takeoff: 432,
    landing: 481,
    score: 37.0,
    note: "foot-speed ok",
  };
  const timing205 = { captureFps: 205.5, stretch: 1 };

  it("Auto keeps only A (drops settling B)", () => {
    const resolved = resolveJumpSet([byronA, byronB], timing205, { jumpCount: "auto" });
    expect(resolved.jumps).toHaveLength(1);
    expect(resolved.jumps[0]!.touchdown).toBe(86);
    expect(resolved.jumps[0]!.takeoff).toBe(122);
    expect(resolved.jumps[0]!.landing).toBe(266);
    expect(resolved.warnings.some((w) => /check LD mark/i.test(w))).toBe(true);
  });

  it("N=1 returns A only (best score)", () => {
    const resolved = resolveJumpSet([byronA, byronB], timing205, { jumpCount: 1 });
    expect(resolved.jumps).toHaveLength(1);
    expect(resolved.jumps[0]!.touchdown).toBe(86);
    expect(resolved.jumps[0]!.landing).toBe(266);
  });

  it("flags Check marks when contact/flight outside 100–600 / 150–800 ms", () => {
    // Flight ~1.11 s at 205.5 fps — still hard-valid (≤1 s contact, ≥150 ms flight) but soft-flagged.
    const longFlight: DetectCandidate = {
      stepOff: 60,
      touchdown: 86,
      takeoff: 122,
      landing: 350,
      score: 40,
    };
    const resolved = resolveJumpSet([longFlight], timing205, { jumpCount: 1 });
    expect(resolved.jumps).toHaveLength(1);
    expect(resolved.warnings.some((w) => /Check marks/i.test(w))).toBe(true);
  });

  it("real 2-rep set (both ~10+ in, similar height) still returns 2", () => {
    // ~11 in each at 52 fps / 4× stretch (flight ~100 frames).
    const r1: DetectCandidate = {
      stepOff: 40,
      touchdown: 80,
      takeoff: 120,
      landing: 220,
      score: 40,
    };
    const r2: DetectCandidate = {
      stepOff: 300,
      touchdown: 340,
      takeoff: 380,
      landing: 480,
      score: 39,
    };
    const timing = { captureFps: 207, stretch: 4, frameTimes: ptsClock(600, 52) };
    const resolved = resolveJumpSet([r1, r2], timing, { jumpCount: "auto" });
    expect(resolved.jumps).toHaveLength(2);
    expect(resolved.jumps[0]!.touchdown).toBe(80);
    expect(resolved.jumps[1]!.touchdown).toBe(340);
  });
});
