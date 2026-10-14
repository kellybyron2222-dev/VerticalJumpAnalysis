import { describe, expect, it } from "vitest";
import {
  normalizeBoxTestHeights,
  recommendBoxHeight,
  startBoxTest,
  summarizeBoxTest,
  type BoxTestHeightSummary,
} from "./boxTest.ts";
import type { TrialRecord } from "./storage.ts";

function jump(
  partial: Partial<TrialRecord> &
    Pick<TrialRecord, "id" | "boxHeightIn" | "rsi" | "gctMs" | "boxTestId">,
): TrialRecord {
  return {
    createdAt: "2026-10-14T12:00:00",
    fps: 170,
    jumpType: "drop",
    armSwing: false,
    notes: "",
    touchdownFrame: 1,
    takeoffFrame: 2,
    landingFrame: 3,
    flightMs: 500,
    heightM: 0.3,
    heightIn: 12,
    heightCm: 30,
    ...partial,
  };
}

describe("box test setup", () => {
  it("requires 3–5 heights", () => {
    expect(normalizeBoxTestHeights([6, 12])).toBeNull();
    expect(normalizeBoxTestHeights([6, 12, 18, 24, 30, 36])).toBeNull();
    expect(normalizeBoxTestHeights([18, 6, 12, 6])).toEqual([6, 12, 18]);
  });

  it("starts a tagged test", () => {
    const test = startBoxTest("depth", [6, 12, 18, 24]);
    expect(test).not.toBeNull();
    expect(test!.jumpType).toBe("depth");
    expect(test!.id.startsWith("boxtest-")).toBe(true);
  });
});

describe("recommendBoxHeight", () => {
  it("picks the highest RSI under the contact target", () => {
    const summaries: BoxTestHeightSummary[] = [
      { boxHeightIn: 6, count: 3, meanRsi: 1.2, meanGctMs: 210 },
      { boxHeightIn: 12, count: 3, meanRsi: 1.5, meanGctMs: 230 },
      { boxHeightIn: 18, count: 3, meanRsi: 1.6, meanGctMs: 280 },
    ];
    const result = recommendBoxHeight(summaries, 250, 0.085);
    expect(result?.recommendedBoxIn).toBe(12);
    expect(result?.meetsTarget).toBe(true);
  });

  it("breaks near-ties within 1x CV toward the lower box", () => {
    const summaries: BoxTestHeightSummary[] = [
      { boxHeightIn: 6, count: 3, meanRsi: 1.48, meanGctMs: 220 },
      { boxHeightIn: 12, count: 3, meanRsi: 1.5, meanGctMs: 220 },
      { boxHeightIn: 18, count: 3, meanRsi: 1.2, meanGctMs: 220 },
    ];
    // |1.5-1.48|/1.5 = 0.013 < 0.085
    const result = recommendBoxHeight(summaries, 250, 0.085);
    expect(result?.recommendedBoxIn).toBe(6);
  });

  it("falls back to the lowest height when none meet contact target", () => {
    const summaries: BoxTestHeightSummary[] = [
      { boxHeightIn: 12, count: 3, meanRsi: 1.5, meanGctMs: 280 },
      { boxHeightIn: 18, count: 3, meanRsi: 1.6, meanGctMs: 300 },
      { boxHeightIn: 6, count: 3, meanRsi: 1.1, meanGctMs: 270 },
    ];
    const result = recommendBoxHeight(summaries, 250, 0.085);
    expect(result?.meetsTarget).toBe(false);
    expect(result?.recommendedBoxIn).toBe(6);
  });

  it("summarizes tagged jumps by box", () => {
    const trials = [
      jump({ id: "a", boxTestId: "t1", boxHeightIn: 6, rsi: 1.2, gctMs: 200 }),
      jump({ id: "b", boxTestId: "t1", boxHeightIn: 6, rsi: 1.4, gctMs: 220 }),
      jump({ id: "c", boxTestId: "t1", boxHeightIn: 12, rsi: 1.5, gctMs: 230 }),
      jump({ id: "d", boxTestId: "other", boxHeightIn: 18, rsi: 2, gctMs: 200 }),
    ];
    const summary = summarizeBoxTest(trials, "t1", [6, 12, 18]);
    expect(summary[0]!.count).toBe(2);
    expect(summary[0]!.meanRsi).toBeCloseTo(1.3, 5);
    expect(summary[1]!.count).toBe(1);
    expect(summary[2]!.count).toBe(0);
  });
});
