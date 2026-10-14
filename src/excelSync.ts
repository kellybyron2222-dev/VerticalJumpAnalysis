import {
  excelAddressForRow,
  firstEmptyDataRow,
  scanAddress,
  trialToExcelRow,
} from "./excelMap.ts";
import {
  loadExcelQueue,
  loadExcelSettings,
  markSynced,
  pendingDropIds,
  saveExcelQueue,
  syncedIds,
  type ExcelSyncSettings,
} from "./excelQueue.ts";
import type { KeyValueStore, TrialRecord } from "./storage.ts";

export interface GraphFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface SyncResult {
  wrote: number;
  skipped: number;
  errors: string[];
}

function workbookItemUrl(workbookPath: string): string {
  // Accept either "/me/drive/root:/path.xlsx" or a path under root.
  if (workbookPath.startsWith("/me/")) return `https://graph.microsoft.com/v1.0${workbookPath}`;
  const trimmed = workbookPath.replace(/^\/+/, "");
  return `https://graph.microsoft.com/v1.0/me/drive/root:/${trimmed}`;
}

async function graphJson<T>(
  fetchImpl: GraphFetch,
  token: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph ${response.status}: ${text.slice(0, 200)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Append drop-jump rows; never rewrite synced ids. Mockable via fetchImpl. */
export async function syncPendingDrops(options: {
  token: string;
  trials: readonly TrialRecord[];
  storage: KeyValueStore;
  fetchImpl?: GraphFetch;
  settings?: ExcelSyncSettings;
}): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const settings = options.settings ?? loadExcelSettings(options.storage);
  let queue = loadExcelQueue(options.storage);
  const already = syncedIds(queue);
  const pending = pendingDropIds(queue).filter((id) => !already.has(id));
  const byId = new Map(options.trials.map((t) => [t.id, t]));
  const result: SyncResult = { wrote: 0, skipped: 0, errors: [] };

  if (pending.length === 0) return result;

  const item = await graphJson<{ id: string }>(
    fetchImpl,
    options.token,
    `${workbookItemUrl(settings.workbookPath)}?$select=id`,
  );
  const sheet = encodeURIComponent(settings.worksheet);
  const base = `https://graph.microsoft.com/v1.0/me/drive/items/${item.id}/workbook/worksheets('${sheet}')`;

  const range = await graphJson<{ values: unknown[][] }>(
    fetchImpl,
    options.token,
    `${base}/range(address='${scanAddress(settings.headerRow)}')?$select=values`,
  );
  const values = range.values ?? [];
  let nextRow = firstEmptyDataRow(values, settings.headerRow + 1);

  for (const trialId of pending) {
    if (already.has(trialId)) {
      result.skipped += 1;
      continue;
    }
    const trial = byId.get(trialId);
    if (!trial) {
      result.skipped += 1;
      continue;
    }
    const row = trialToExcelRow(trial);
    if (!row) {
      result.skipped += 1;
      continue;
    }
    try {
      await graphJson(
        fetchImpl,
        options.token,
        `${base}/range(address='${excelAddressForRow(nextRow)}')`,
        {
          method: "PATCH",
          body: JSON.stringify({ values: [row] }),
        },
      );
      queue = markSynced(queue, trialId);
      already.add(trialId);
      nextRow += 1;
      result.wrote += 1;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }

  saveExcelQueue(options.storage, queue);
  return result;
}
