import { describe, expect, it } from "vitest";
import type { DetectCandidate } from "./detectDiag.ts";
import {
  cycleRealDurations,
  cyclesSeparated,
  mergeFragmentCandidates,
  pickApproachPlant,
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

describe("Byron penultimate 2026-10-27b — approach plant", () => {
  /**
   * Exact-ish candidates from Byron's heavy Auto run (790 frames, 171.2 fps, 4×).
   * Presentation clock ≈ 171.2/4 fps so 4× stretch yields real contact ~310 ms for TD292–TO345.
   */
  const playbackFps = 171.2 / 4;
  const timing171 = {
    captureFps: 171.2,
    stretch: 4,
    frameTimes: ptsClock(800, playbackFps),
  };

  const td556: DetectCandidate = {
    stepOff: 424,
    touchdown: 556,
    takeoff: 559,
    landing: 664,
    score: 45.6,
    note: "short contact",
  };
  const td292: DetectCandidate = {
    stepOff: 291,
    touchdown: 292,
    takeoff: 345,
    landing: 439,
    score: 43.9,
    note: "ok",
  };
  const td75: DetectCandidate = {
    stepOff: null,
    touchdown: 75,
    takeoff: 76,
    landing: 248,
    score: 42.9,
    note: "contact marginal",
  };
  const td439: DetectCandidate = {
    stepOff: 438,
    touchdown: 439,
    takeoff: 466,
    landing: 560,
    score: 40.0,
    note: "later fragment",
  };

  it("4× math: TD292–TO345 plant contact is ~310 ms real (in 120–400)", () => {
    const { contactS } = cycleRealDurations(td292, timing171);
    expect(contactS * 1000).toBeGreaterThan(120);
    expect(contactS * 1000).toBeLessThan(400);
    expect(contactS * 1000).toBeCloseTo((53 / playbackFps / 4) * 1000, 0);
    expect(validateCandidateRealTime(td292, timing171).ok).toBe(true);
  });

  it("Drop mode still rejects approach candidates without a real drop, then fails merge", () => {
    const resolved = resolveJumpSet([td556, td292, td75, td439], timing171, {
      jumpCount: "auto",
      requireDrop: true,
    });
    expect(resolved.notes.some((n) => /no real drop\/step-off/i.test(n))).toBe(true);
    // Earliest-TD merge of these fragments is implausible (4 ms contact) — fails.
    expect(resolved.jumps.length === 0 || resolved.implausible).toBe(true);
  });

  it("Penultimate / one-step keeps TD292 plant (no drop filter)", () => {
    const resolved = resolveJumpSet([td556, td292, td75, td439], timing171, {
      jumpCount: "auto",
      requireDrop: false,
    });
    expect(resolved.implausible).toBe(false);
    expect(resolved.jumps).toHaveLength(1);
    expect(resolved.jumps[0]!.touchdown).toBe(292);
    expect(resolved.jumps[0]!.takeoff).toBe(345);
    expect(resolved.jumps[0]!.landing).toBe(439);
    expect(resolved.notes.some((n) => /no real drop\/step-off/i.test(n))).toBe(false);
  });

  it("pickApproachPlant selects last contact before biggest valid flight", () => {
    const plant = pickApproachPlant([td556, td292, td75, td439], timing171);
    expect(plant).not.toBeNull();
    expect(plant!.touchdown).toBe(292);
    expect(plant!.takeoff).toBe(345);
  });
});
