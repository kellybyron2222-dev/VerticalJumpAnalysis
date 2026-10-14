import {
  DEFAULT_HEADER_ROW,
  DEFAULT_WORKBOOK_PATH,
  DEFAULT_WORKSHEET,
} from "./config.ts";
import type { JumpType, KeyValueStore, TrialRecord } from "./storage.ts";

export const EXCEL_QUEUE_KEY = "jumpLab.excelQueue.v1";
export const EXCEL_SETTINGS_KEY = "jumpLab.excelSettings.v1";

export type QueueItemStatus = "pending" | "synced" | "blocked";

export interface ExcelQueueItem {
  trialId: string;
  jumpType: JumpType;
  status: QueueItemStatus;
  /** Why a jump is not synced (e.g. depth section TBD). */
  note?: string;
  syncedAt?: string;
}

export interface ExcelQueueState {
  items: ExcelQueueItem[];
}

export interface ExcelSyncSettings {
  workbookPath: string;
  worksheet: string;
  headerRow: number;
}

export function defaultExcelSettings(): ExcelSyncSettings {
  return {
    workbookPath: DEFAULT_WORKBOOK_PATH,
    worksheet: DEFAULT_WORKSHEET,
    headerRow: DEFAULT_HEADER_ROW,
  };
}

export function loadExcelSettings(storage: KeyValueStore): ExcelSyncSettings {
  try {
    const raw = storage.getItem(EXCEL_SETTINGS_KEY);
    if (!raw) return defaultExcelSettings();
    const data = JSON.parse(raw) as Partial<ExcelSyncSettings>;
    const base = defaultExcelSettings();
    return {
      workbookPath:
        typeof data.workbookPath === "string" && data.workbookPath ? data.workbookPath : base.workbookPath,
      worksheet: typeof data.worksheet === "string" && data.worksheet ? data.worksheet : base.worksheet,
      headerRow:
        typeof data.headerRow === "number" && data.headerRow >= 1 ? Math.floor(data.headerRow) : base.headerRow,
    };
  } catch {
    return defaultExcelSettings();
  }
}

export function saveExcelSettings(storage: KeyValueStore, settings: ExcelSyncSettings): boolean {
  try {
    storage.setItem(EXCEL_SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function loadExcelQueue(storage: KeyValueStore): ExcelQueueState {
  try {
    const raw = storage.getItem(EXCEL_QUEUE_KEY);
    if (!raw) return { items: [] };
    const data = JSON.parse(raw) as Partial<ExcelQueueState>;
    if (!Array.isArray(data.items)) return { items: [] };
    return {
      items: data.items.filter(
        (item): item is ExcelQueueItem =>
          !!item &&
          typeof item.trialId === "string" &&
          (item.jumpType === "drop" || item.jumpType === "depth") &&
          (item.status === "pending" || item.status === "synced" || item.status === "blocked"),
      ),
    };
  } catch {
    return { items: [] };
  }
}

export function saveExcelQueue(storage: KeyValueStore, state: ExcelQueueState): boolean {
  try {
    storage.setItem(EXCEL_QUEUE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Enqueue a saved jump if not already tracked. Depth jumps are blocked. */
export function enqueueTrial(state: ExcelQueueState, trial: TrialRecord): ExcelQueueState {
  if (state.items.some((item) => item.trialId === trial.id)) return state;
  if (trial.jumpType === "depth") {
    return {
      items: [
        ...state.items,
        {
          trialId: trial.id,
          jumpType: "depth",
          status: "blocked",
          note: "Depth jump section TBD",
        },
      ],
    };
  }
  return {
    items: [
      ...state.items,
      {
        trialId: trial.id,
        jumpType: "drop",
        status: "pending",
      },
    ],
  };
}

export function markSynced(state: ExcelQueueState, trialId: string, at = new Date().toISOString()): ExcelQueueState {
  return {
    items: state.items.map((item) =>
      item.trialId === trialId ? { ...item, status: "synced" as const, syncedAt: at, note: undefined } : item,
    ),
  };
}

export function pendingDropIds(state: ExcelQueueState): string[] {
  return state.items.filter((item) => item.status === "pending" && item.jumpType === "drop").map((i) => i.trialId);
}

export function syncStatusFor(state: ExcelQueueState, trialId: string): QueueItemStatus | "none" {
  return state.items.find((item) => item.trialId === trialId)?.status ?? "none";
}

/** Already-synced ids — never write these again. */
export function syncedIds(state: ExcelQueueState): Set<string> {
  return new Set(state.items.filter((item) => item.status === "synced").map((item) => item.trialId));
}
