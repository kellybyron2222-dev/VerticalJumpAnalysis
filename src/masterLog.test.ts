import { describe, expect, it } from "vitest";
import {
  MASTER_LOG_HEADERS,
  buildCsvText,
  isoWeek,
  masterRowsFromTrials,
  sortMasterRows,
  trialToMasterRow,
  trialToViewRow,
} from "./masterLog.ts";
import type { TrialRecord } from "./storage.ts";

function trial(partial: Partial<TrialRecord> & Pick<TrialRecord, "id" | "jumpType">): TrialRecord {
  return {
    createdAt: "2026-10-14T15:00:00",
    fps: 170,
    boxHeightIn: 12,
    armSwing: true,
    notes: "good, day",
    touchdownFrame: 1,
    takeoffFrame: 2,
    landingFrame: 3,
    gctMs: 220.44,
    flightMs: 510.2,
    heightM: 0.33,
    heightIn: 12.987,
    heightCm: 33,
    rsi: 1.4567,
    boxTestId: "boxtest-1",
    ...partial,
  };
}

describe("master log row mapping", () => {
  it("puts Jump Test paste columns first, then extras", () => {
    expect([...MASTER_LOG_HEADERS].slice(0, 8)).toEqual([
      "Date",
      "Week",
      "Box",
      "Arm swing",
      "Height (in)",
      "GCT (ms)",
      "RSI (m/s)",
      "Notes",
    ]);
    const row = trialToMasterRow(trial({ id: "a", jumpType: "drop" }));
    expect(row[0]).toBe("2026-10-14");
    expect(row[1]).toBe(isoWeek(new Date("2026-10-14T15:00:00")));
    expect(row[2]).toBe(12);
    expect(row[3]).toBe("Yes");
    expect(row[4]).toBe(12.99);
    expect(row[5]).toBe(220.4);
    expect(row[6]).toBe(1.46);
    expect(row[7]).toBe("good, day");
    expect(row[8]).toBe("drop");
    expect(row[9]).toBe(510.2);
    expect(row[10]).toBe("boxtest-1");
  });

  it("includes depth and box-test jumps", () => {
    const rows = masterRowsFromTrials([
      trial({ id: "d", jumpType: "depth", boxTestId: undefined }),
      trial({ id: "b", jumpType: "drop" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]![8]).toBe("depth");
    expect(rows[0]![10]).toBe("");
  });

  it("builds CSV with escaped notes", () => {
    const csv = buildCsvText([trial({ id: "a", jumpType: "drop" })]);
    expect(csv.split("\n")[0]).toContain("Date,Week,Box");
    expect(csv).toContain('"good, day"');
  });

  it("sorts view rows by box height", () => {
    const rows = [
      trialToViewRow(trial({ id: "a", jumpType: "drop", boxHeightIn: 18 })),
      trialToViewRow(trial({ id: "b", jumpType: "drop", boxHeightIn: 6 })),
    ];
    expect(sortMasterRows(rows, "box", true).map((r) => r.box)).toEqual([6, 18]);
  });
});
