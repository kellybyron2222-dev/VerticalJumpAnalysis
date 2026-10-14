import type { TrialRecord } from "./storage.ts";

/** One Excel row for columns A–H (Date … Notes). */
export type ExcelJumpRow = [
  string, // Date
  number | "", // Week (ISO) or blank
  number, // Box
  string, // Arm swing
  number, // Height (in)
  number, // GCT (ms)
  number, // RSI (m/s)
  string, // Notes
];

/** ISO week number (1–53) for a local calendar date. */
export function isoWeek(date: Date): number {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year.
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function formatExcelDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function roundHeightIn(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundGctMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export function roundRsi(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Map a drop-jump trial to the Friday section row shape.
 * Depth jumps return null — their workbook section is TBD.
 */
export function trialToExcelRow(trial: TrialRecord): ExcelJumpRow | null {
  if (trial.jumpType !== "drop") return null;
  const created = new Date(trial.createdAt);
  const week = Number.isNaN(created.getTime()) ? "" : isoWeek(created);
  return [
    formatExcelDate(trial.createdAt),
    week,
    roundHeightIn(trial.boxHeightIn),
    trial.armSwing ? "Yes" : "No",
    roundHeightIn(trial.heightIn),
    roundGctMs(trial.gctMs),
    roundRsi(trial.rsi),
    trial.notes ?? "",
  ];
}

/**
 * First 1-based worksheet row at or below `firstDataRow` whose column A is empty
 * in a values matrix that starts at that data row (index 0 = firstDataRow).
 */
export function firstEmptyDataRow(
  values: readonly (readonly unknown[])[],
  firstDataRow: number,
  scanRows = 177,
): number {
  for (let i = 0; i < scanRows; i += 1) {
    const cell = values[i]?.[0];
    if (cell === null || cell === undefined || cell === "") return firstDataRow + i;
  }
  return firstDataRow + scanRows;
}

export function excelAddressForRow(row: number): string {
  return `A${row}:H${row}`;
}

export function scanAddress(headerRow: number): string {
  const first = headerRow + 1;
  return `A${first}:H${first + 176}`;
}
