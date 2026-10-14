import { describe, expect, it } from "vitest";
import type { MetricBaseline, WeeklyMean } from "./baseline.ts";
import {
  cellFromMetrics,
  contactTrendingWorse,
  fullProfileDays,
  loadGctTargetMs,
  metricFromWeeks,
  needsProfileRetest,
  raiseBoxSignal,
  saveGctTargetMs,
  wholeWeeksBetween,
} from "./raiseBox.ts";
import type { TrialRecord } from "./storage.ts";

function week(week: string, mean: number): WeeklyMean {
  return { week, mean, best: mean, count: 3 };
}

function heightStub(): MetricBaseline {
  const stub = metricFromWeeks("rsi", [week("2026-08-03", 12)], "2026-09-14", 12, 0.1);
  return { ...stub, metric: "heightIn", higherIsBetter: true };
}

describe("raise box signal", () => {
  const weeks = [
    week("2026-08-03", 1.4),
    week("2026-08-10", 1.4),
    week("2026-08-17", 1.4),
    week("2026-08-24", 1.4),
    week("2026-08-31", 1.4),
    week("2026-09-07", 1.6), // prior: +14% vs 1.4
    week("2026-09-14", 1.65), // current: +18%
  ];
  const gctOk = [
    week("2026-08-03", 220),
    week("2026-08-10", 220),
    week("2026-08-17", 220),
    week("2026-08-24", 220),
    week("2026-08-31", 220),
    week("2026-09-07", 230),
    week("2026-09-14", 240),
  ];

  it("signals ready when RSI is up >1x CV for two weeks and GCT stays at target", () => {
    const rsi = metricFromWeeks("rsi", weeks, "2026-09-14", 1.4, 0.085);
    const gct = metricFromWeeks("gctMs", gctOk, "2026-09-14", 220, 0.085);
    const cell = cellFromMetrics("drop", 12, "2026-09-14", rsi, gct, heightStub());
    expect(raiseBoxSignal(cell, 250).signal).toBe("ready");
  });

  it("holds when contact is above the target", () => {
    const rsi = metricFromWeeks("rsi", weeks, "2026-09-14", 1.4, 0.085);
    const high = gctOk.map((w) =>
      w.week === "2026-09-14" ? { ...w, mean: 280 } : w,
    );
    const gct = metricFromWeeks("gctMs", high, "2026-09-14", 220, 0.085);
    const cell = cellFromMetrics("drop", 12, "2026-09-14", rsi, gct, heightStub());
    expect(raiseBoxSignal(cell, 250).signal).toBe("hold");
  });

  it("holds when contact is trending worse", () => {
    const rsi = metricFromWeeks("rsi", weeks, "2026-09-14", 1.4, 0.085);
    const gct = metricFromWeeks("gctMs", gctOk, "2026-09-14", 220, 0.05, "watch");
    // Force a positive delta (worse) with watch flag.
    gct.delta = 0.12;
    gct.flag = "watch";
    expect(contactTrendingWorse(gct)).toBe(true);
    const cell = cellFromMetrics("drop", 12, "2026-09-14", rsi, gct, heightStub());
    expect(raiseBoxSignal(cell, 250).signal).toBe("hold");
  });
});

describe("profile retest", () => {
  function jump(day: string, box: number, type: "drop" | "depth" = "drop"): TrialRecord {
    return {
      id: `${day}-${box}`,
      createdAt: `${day}T12:00:00`,
      fps: 170,
      jumpType: type,
      boxHeightIn: box,
      armSwing: false,
      notes: "",
      touchdownFrame: 1,
      takeoffFrame: 2,
      landingFrame: 3,
      gctMs: 220,
      flightMs: 500,
      heightM: 0.3,
      heightIn: 12,
      heightCm: 30,
      rsi: 1.4,
    };
  }

  it("finds days with 3+ box heights", () => {
    const trials = [
      jump("2026-08-01", 6),
      jump("2026-08-01", 12),
      jump("2026-08-01", 18),
      jump("2026-08-08", 6),
      jump("2026-08-08", 12),
    ];
    expect(fullProfileDays(trials, "drop")).toEqual(["2026-08-01"]);
  });

  it("reminds after 4+ weeks since the last full profile day", () => {
    const trials = [
      jump("2026-08-01", 6),
      jump("2026-08-01", 12),
      jump("2026-08-01", 18),
    ];
    expect(wholeWeeksBetween("2026-08-01", "2026-08-29")).toBe(4);
    expect(needsProfileRetest(trials, "2026-08-29", "drop").needed).toBe(true);
    expect(needsProfileRetest(trials, "2026-08-15", "drop").needed).toBe(false);
  });

  it("stores an editable GCT target", () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    expect(loadGctTargetMs(storage)).toBe(250);
    expect(saveGctTargetMs(storage, 240)).toBe(true);
    expect(loadGctTargetMs(storage)).toBe(240);
  });
});
