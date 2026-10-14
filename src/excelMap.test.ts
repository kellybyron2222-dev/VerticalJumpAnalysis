import { describe, expect, it } from "vitest";
import {
  firstEmptyDataRow,
  isoWeek,
  scanAddress,
  trialToExcelRow,
} from "./excelMap.ts";
import type { TrialRecord } from "./storage.ts";

function trial(partial: Partial<TrialRecord> & Pick<TrialRecord, "id" | "jumpType">): TrialRecord {
  return {
    createdAt: "2026-10-14T15:00:00",
    fps: 170,
    boxHeightIn: 12,
    armSwing: true,
    notes: "good",
    touchdownFrame: 1,
    takeoffFrame: 2,
    landingFrame: 3,
    gctMs: 220.44,
    flightMs: 500,
    heightM: 0.33,
    heightIn: 12.987,
    heightCm: 33,
    rsi: 1.4567,
    ...partial,
  };
}

describe("excel row mapping", () => {
  it("maps a drop jump into A:H with rounded numbers", () => {
    const row = trialToExcelRow(trial({ id: "a", jumpType: "drop" }));
    expect(row).toEqual([
      "2026-10-14",
      isoWeek(new Date("2026-10-14T15:00:00")),
      12,
      "Yes",
      12.99,
      220.4,
      1.46,
      "good",
    ]);
  });

  it("refuses depth jumps until their section exists", () => {
    expect(trialToExcelRow(trial({ id: "b", jumpType: "depth" }))).toBeNull();
  });

  it("finds the first empty row below the header block", () => {
    const values = [
      ["2026-10-01", 40, 12, "Yes", 14, 220, 1.4, ""],
      ["", "", "", "", "", "", "", ""],
    ];
    expect(firstEmptyDataRow(values, 24)).toBe(25);
    expect(scanAddress(23)).toBe("A24:H200");
  });
});
