import { describe, expect, it } from "vitest";
import {
  baselineStatus,
  classifyFlag,
  coefficientOfVariation,
  DEFAULT_CV,
  evaluateCell,
  evaluateMetric,
  setRebaselineWeek,
  weeklyMeans,
  type WeeklyMean,
} from "./baseline.ts";
import { weekKey, trialDay } from "./sessions.ts";
import type { TrialRecord } from "./storage.ts";

function jump(
  partial: Partial<TrialRecord> &
    Pick<TrialRecord, "id" | "createdAt" | "jumpType" | "boxHeightIn" | "heightIn" | "gctMs" | "rsi">,
): TrialRecord {
  return {
    fps: 170,
    armSwing: false,
    notes: "",
    touchdownFrame: 10,
    takeoffFrame: 50,
    landingFrame: 140,
    flightMs: 500,
    heightM: 0.3,
    heightCm: 30,
    ...partial,
  };
}

/** Mondays in 2026 for building week-separated samples. */
const W = [
  "2026-08-03T12:00:00", // week 0
  "2026-08-10T12:00:00",
  "2026-08-17T12:00:00",
  "2026-08-24T12:00:00",
  "2026-08-31T12:00:00",
  "2026-09-07T12:00:00",
  "2026-09-14T12:00:00", // week 6 = current in 7-week series
];

describe("baseline status and CV", () => {
  it("marks provisional at 3 and established at 6 prior weeks", () => {
    expect(baselineStatus(0)).toBe("none");
    expect(baselineStatus(2)).toBe("none");
    expect(baselineStatus(3)).toBe("provisional");
    expect(baselineStatus(5)).toBe("provisional");
    expect(baselineStatus(6)).toBe("established");
  });

  it("uses default CV until 3 weekly means exist", () => {
    expect(coefficientOfVariation([10, 11])).toBe(DEFAULT_CV);
    const cv = coefficientOfVariation([10, 10.5, 9.5, 10.2]);
    expect(cv).toBeGreaterThan(0);
    expect(cv).toBeLessThan(0.2);
  });
});

describe("flags", () => {
  it("does not flag provisional baselines", () => {
    expect(classifyFlag("provisional", 0.2, null, 0.085)).toBe("none");
  });

  it("classifies normal, watch, and real by CV multiples", () => {
    const cv = 0.1;
    expect(classifyFlag("established", 0.05, null, cv)).toBe("normal");
    expect(classifyFlag("established", 0.15, null, cv)).toBe("watch");
    expect(classifyFlag("established", 0.25, null, cv)).toBe("real");
  });

  it("flags two consecutive weeks over 1x CV in the same direction as real", () => {
    const cv = 0.1;
    expect(classifyFlag("established", 0.12, 0.11, cv)).toBe("real");
    expect(classifyFlag("established", 0.12, -0.11, cv)).toBe("watch");
  });

  it("treats contact-time increases as the signed direction for streaks", () => {
    const weeks: WeeklyMean[] = [
      { week: "2026-08-03", mean: 220, best: 210, count: 3 },
      { week: "2026-08-10", mean: 220, best: 210, count: 3 },
      { week: "2026-08-17", mean: 220, best: 210, count: 3 },
      { week: "2026-08-24", mean: 220, best: 210, count: 3 },
      { week: "2026-08-31", mean: 220, best: 210, count: 3 },
      { week: "2026-09-07", mean: 250, best: 240, count: 3 }, // prior week up
      { week: "2026-09-14", mean: 255, best: 245, count: 3 }, // current still up
    ];
    const result = evaluateMetric(weeks, "2026-09-14", null, "gctMs");
    expect(result.status).toBe("established");
    expect(result.delta).not.toBeNull();
    expect(result.delta!).toBeGreaterThan(0);
    expect(result.flag).toBe("real");
  });
});

describe("weekly means and cell evaluation", () => {
  it("averages jumps within a week and keeps the best as PR", () => {
    const trials = [
      jump({
        id: "a",
        createdAt: W[0]!,
        jumpType: "drop",
        boxHeightIn: 12,
        heightIn: 12,
        gctMs: 240,
        rsi: 1.2,
      }),
      jump({
        id: "b",
        createdAt: "2026-08-04T12:00:00",
        jumpType: "drop",
        boxHeightIn: 12,
        heightIn: 14,
        gctMs: 200,
        rsi: 1.6,
      }),
    ];
    const weeks = weeklyMeans(trials, "drop", 12, "heightIn");
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.mean).toBeCloseTo(13, 5);
    expect(weeks[0]!.best).toBe(14);
  });

  it("builds an established baseline from the last 6 prior weeks only", () => {
    const trials = W.map((createdAt, i) =>
      jump({
        id: String(i),
        createdAt,
        jumpType: "drop",
        boxHeightIn: 6,
        heightIn: 10 + i * 0.1,
        gctMs: 220,
        rsi: 1.4,
      }),
    );
    const current = weekKey(trialDay(W[6]!));
    const cell = evaluateCell(trials, "drop", 6, current, null);
    expect(cell.metrics.heightIn.status).toBe("established");
    expect(cell.metrics.heightIn.priorWeeks).toHaveLength(6);
    // Baseline = mean of weeks 0..5 heights 10.0 .. 10.5
    expect(cell.metrics.heightIn.baseline).toBeCloseTo(10.25, 5);
    expect(cell.metrics.heightIn.currentWeek?.mean).toBeCloseTo(10.6, 5);
  });

  it("honors a manual re-baseline cut week", () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    const cut = weekKey(trialDay(W[4]!));
    expect(setRebaselineWeek(storage, "drop", 6, cut)).toBe(true);
    const trials = W.map((createdAt, i) =>
      jump({
        id: String(i),
        createdAt,
        jumpType: "drop",
        boxHeightIn: 6,
        heightIn: 10,
        gctMs: 220,
        rsi: 1.4,
      }),
    );
    const current = weekKey(trialDay(W[6]!));
    const cell = evaluateCell(trials, "drop", 6, current, cut);
    // Weeks at cut and after, excluding current → W4, W5 = 2 prior → no baseline
    expect(cell.metrics.heightIn.status).toBe("none");
    expect(cell.metrics.heightIn.priorWeeks).toHaveLength(2);
  });
});
