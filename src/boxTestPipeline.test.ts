import { describe, expect, it } from "vitest";
import { recomputeRowMetrics, summariesFromRowResults, type BoxTestRowResult } from "./boxTestPipeline.ts";

function row(partial: Partial<BoxTestRowResult> & Pick<BoxTestRowResult, "boxHeightIn" | "gctMs" | "rsi">): BoxTestRowResult {
  return {
    fileName: "clip.mov",
    fps: 170,
    slowMoFactor: 4,
    frameTimes: [],
    stepOff: 10,
    touchdown: 40,
    takeoff: 80,
    landing: 160,
    heightIn: 14,
    ...partial,
  };
}

describe("box test row summaries", () => {
  it("maps one jump per height for the recommender", () => {
    const summaries = summariesFromRowResults([
      row({ boxHeightIn: 12, gctMs: 230, rsi: 1.5 }),
      row({ boxHeightIn: 6, gctMs: 210, rsi: 1.2 }),
    ]);
    expect(summaries.map((s) => s.boxHeightIn)).toEqual([6, 12]);
    expect(summaries[1]!.count).toBe(1);
    expect(summaries[1]!.meanRsi).toBe(1.5);
  });

  it("recomputes metrics after a mark nudge", () => {
    // Uniform 170 fps clock so frame deltas are stable.
    const times = Array.from({ length: 200 }, (_, i) => i / 170);
    const base = row({
      boxHeightIn: 12,
      frameTimes: times,
      touchdown: 40,
      takeoff: 80,
      landing: 160,
      gctMs: 1,
      rsi: 1,
      heightIn: 1,
      slowMoFactor: 1,
      fps: 170,
    });
    const updated = recomputeRowMetrics(base, 40, 80, 160);
    expect(updated).not.toBeNull();
    expect(updated!.gctMs).toBeGreaterThan(0);
    expect(updated!.rsi).toBeGreaterThan(0);
    expect(recomputeRowMetrics(base, 80, 40, 160)).toBeNull();
  });
});
