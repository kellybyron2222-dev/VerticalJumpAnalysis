import * as XLSX from "xlsx";
import type { TrialRecord } from "./storage.ts";

/** Workbook paste order first, then extras. */
export const MASTER_LOG_HEADERS = [
  "Date",
  "Week",
  "Box",
  "Arm swing",
  "Height (in)",
  "GCT (ms)",
  "RSI (m/s)",
  "Notes",
  "Jump type",
  "Flight (ms)",
  "Test id",
] as const;

export type MasterLogHeader = (typeof MASTER_LOG_HEADERS)[number];

/** One export/table row aligned with MASTER_LOG_HEADERS. */
export type MasterLogRow = [
  string,
  number | "",
  number,
  string,
  number,
  number,
  number,
  string,
  string,
  number,
  string,
];

export type MasterSortKey =
  | "date"
  | "week"
  | "jumpType"
  | "box"
  | "arm"
  | "height"
  | "gct"
  | "flight"
  | "rsi"
  | "testId"
  | "notes";

export interface MasterLogViewRow {
  id: string;
  date: string;
  week: number | "";
  jumpType: "drop" | "depth";
  box: number;
  armSwing: boolean;
  heightIn: number;
  gctMs: number;
  flightMs: number;
  rsi: number;
  testId: string;
  notes: string;
  createdAt: string;
}

/** ISO week number (1–53) for a local calendar date. */
export function isoWeek(date: Date): number {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function formatLogDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Map any saved jump (drop, depth, box-test) into the master-log row shape. */
export function trialToMasterRow(trial: TrialRecord): MasterLogRow {
  const created = new Date(trial.createdAt);
  const week = Number.isNaN(created.getTime()) ? "" : isoWeek(created);
  return [
    formatLogDate(trial.createdAt),
    week,
    round2(trial.boxHeightIn),
    trial.armSwing ? "Yes" : "No",
    round2(trial.heightIn),
    round1(trial.gctMs),
    round2(trial.rsi),
    trial.notes ?? "",
    trial.jumpType,
    round1(trial.flightMs),
    trial.boxTestId ?? trial.setId ?? "",
  ];
}

export function trialToViewRow(trial: TrialRecord): MasterLogViewRow {
  const row = trialToMasterRow(trial);
  return {
    id: trial.id,
    date: row[0],
    week: row[1],
    jumpType: trial.jumpType,
    box: row[2],
    armSwing: trial.armSwing,
    heightIn: row[4],
    gctMs: row[5],
    flightMs: row[9],
    rsi: row[6],
    testId: row[10],
    notes: row[7],
    createdAt: trial.createdAt,
  };
}

export function sortMasterRows(
  rows: readonly MasterLogViewRow[],
  key: MasterSortKey,
  ascending: boolean,
): MasterLogViewRow[] {
  const dir = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

function sortValue(row: MasterLogViewRow, key: MasterSortKey): string | number {
  switch (key) {
    case "date":
      return row.date;
    case "week":
      return row.week === "" ? -1 : row.week;
    case "jumpType":
      return row.jumpType;
    case "box":
      return row.box;
    case "arm":
      return row.armSwing ? 1 : 0;
    case "height":
      return row.heightIn;
    case "gct":
      return row.gctMs;
    case "flight":
      return row.flightMs;
    case "rsi":
      return row.rsi;
    case "testId":
      return row.testId;
    case "notes":
      return row.notes.toLowerCase();
  }
}

export function masterRowsFromTrials(trials: readonly TrialRecord[]): MasterLogRow[] {
  return trials.map(trialToMasterRow);
}

/** First 8 columns — Jump Test paste order for Drop / Depth sheets. */
export const PASTE_LOG_HEADERS = MASTER_LOG_HEADERS.slice(0, 8);

export function pasteRowFromTrial(trial: TrialRecord): (string | number)[] {
  return trialToMasterRow(trial).slice(0, 8);
}

function sheetFromPasteRows(trials: readonly TrialRecord[]) {
  const rows = [[...PASTE_LOG_HEADERS], ...trials.map(pasteRowFromTrial)];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = PASTE_LOG_HEADERS.map((header) => ({
    wch: Math.max(12, header.length + 2),
  }));
  return sheet;
}

/** Excel export: Drop jump + Depth jump sheets (paste columns only). */
export function buildWorkbookBlob(trials: readonly TrialRecord[]): Blob {
  const drops = trials.filter((t) => t.jumpType === "drop");
  const depths = trials.filter((t) => t.jumpType === "depth");
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheetFromPasteRows(drops), "Drop jump");
  XLSX.utils.book_append_sheet(book, sheetFromPasteRows(depths), "Depth jump");
  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** GitHub sync CSV — full MASTER_LOG_HEADERS, all jump types. Do not change shape. */
export function buildCsvText(trials: readonly TrialRecord[]): string {
  const lines = [MASTER_LOG_HEADERS.join(",")];
  for (const row of masterRowsFromTrials(trials)) {
    lines.push(row.map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Master-log download CSV: Drop jump section then Depth jump section (paste columns). */
export function buildExportCsvText(trials: readonly TrialRecord[]): string {
  const drops = trials.filter((t) => t.jumpType === "drop");
  const depths = trials.filter((t) => t.jumpType === "depth");
  const lines: string[] = [];
  lines.push("Drop jump");
  lines.push(PASTE_LOG_HEADERS.join(","));
  for (const trial of drops) {
    lines.push(pasteRowFromTrial(trial).map(csvEscape).join(","));
  }
  lines.push("");
  lines.push("Depth jump");
  lines.push(PASTE_LOG_HEADERS.join(","));
  for (const trial of depths) {
    lines.push(pasteRowFromTrial(trial).map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** True when the user dismissed the iOS/share sheet (not a failure). */
export function isShareAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/** iOS-friendly download: Web Share with File when possible, else anchor download. */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
    } catch (error) {
      // Cancelling the share sheet is not an error — stay silent.
      if (isShareAbort(error)) return;
      throw error;
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
