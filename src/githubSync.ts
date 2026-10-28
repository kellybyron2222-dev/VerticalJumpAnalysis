import { buildCsvText } from "./masterLog.ts";
import type { KeyValueStore, TrialRecord } from "./storage.ts";

export const GITHUB_TOKEN_KEY = "jumpLab.githubToken.v1";
export const GITHUB_SYNC_META_KEY = "jumpLab.githubSyncMeta.v1";
/** Local tombstones for jumps the user explicitly deleted (survives across syncs). */
export const GITHUB_DELETED_IDS_KEY = "jumpLab.githubDeletedIds.v1";
export const GITHUB_REPO = "kellybyron2222-dev/VerticalJumpAnalysis";
export const GITHUB_DATA_BRANCH = "data";
export const GITHUB_CSV_PATH = "data/jump-log.csv";
export const GITHUB_JSON_PATH = "data/jump-log.json";

export interface GitHubSyncMeta {
  dirty: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** True after a successful pull/merge at least once with this token/device. */
  mergedOnce: boolean;
}

export interface GitHubFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface RemoteLogPayload {
  trials: TrialRecord[];
  updatedAt: string;
  /** Explicit deletes — stale clients must never wipe remote rows by omission. */
  deletedIds?: string[];
}

export function loadGithubToken(storage: KeyValueStore): string {
  try {
    return storage.getItem(GITHUB_TOKEN_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveGithubToken(storage: KeyValueStore, token: string): boolean {
  try {
    const trimmed = token.trim();
    if (!trimmed) storage.setItem(GITHUB_TOKEN_KEY, "");
    else storage.setItem(GITHUB_TOKEN_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}

export function defaultSyncMeta(): GitHubSyncMeta {
  return { dirty: false, lastSyncedAt: null, lastError: null, mergedOnce: false };
}

export function loadSyncMeta(storage: KeyValueStore): GitHubSyncMeta {
  try {
    const raw = storage.getItem(GITHUB_SYNC_META_KEY);
    if (!raw) return defaultSyncMeta();
    const data = JSON.parse(raw) as Partial<GitHubSyncMeta>;
    return {
      dirty: Boolean(data.dirty),
      lastSyncedAt: typeof data.lastSyncedAt === "string" ? data.lastSyncedAt : null,
      lastError: typeof data.lastError === "string" ? data.lastError : null,
      mergedOnce: Boolean(data.mergedOnce),
    };
  } catch {
    return defaultSyncMeta();
  }
}

export function saveSyncMeta(storage: KeyValueStore, meta: GitHubSyncMeta): boolean {
  try {
    storage.setItem(GITHUB_SYNC_META_KEY, JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

export function markDirty(storage: KeyValueStore): void {
  const meta = loadSyncMeta(storage);
  saveSyncMeta(storage, { ...meta, dirty: true, lastError: null });
}

export function loadDeletedIds(storage: KeyValueStore): string[] {
  try {
    const raw = storage.getItem(GITHUB_DELETED_IDS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return [
      ...new Set(
        data.filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveDeletedIds(storage: KeyValueStore, ids: readonly string[]): boolean {
  try {
    const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
    storage.setItem(GITHUB_DELETED_IDS_KEY, JSON.stringify(unique));
    return true;
  } catch {
    return false;
  }
}

/** Record an explicit delete so sync will not resurrect the row from remote. */
export function markDeleted(storage: KeyValueStore, id: string): void {
  if (!id) return;
  const next = new Set(loadDeletedIds(storage));
  next.add(id);
  saveDeletedIds(storage, [...next]);
}

export function mergeDeletedIds(
  local: readonly string[],
  remote: readonly string[],
): string[] {
  return [...new Set([...remote, ...local].filter((id) => id.length > 0))].sort();
}

/**
 * Merge local and remote trials by id. Same id keeps the record with the later
 * createdAt (tie → local). Remote-only ids restore a cleared phone.
 */
export function mergeTrials(
  local: readonly TrialRecord[],
  remote: readonly TrialRecord[],
): TrialRecord[] {
  const map = new Map<string, TrialRecord>();
  for (const trial of remote) {
    if (trial?.id) map.set(trial.id, trial);
  }
  for (const trial of local) {
    if (!trial?.id) continue;
    const existing = map.get(trial.id);
    if (!existing || trial.createdAt >= existing.createdAt) map.set(trial.id, trial);
  }
  return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Drop trials whose ids appear in the tombstone set. */
export function applyTombstones(
  trials: readonly TrialRecord[],
  deletedIds: readonly string[],
): TrialRecord[] {
  if (deletedIds.length === 0) return [...trials];
  const dead = new Set(deletedIds);
  return trials.filter((t) => !dead.has(t.id));
}

/** Stable fingerprint so we can detect saves/deletes during an in-flight push. */
export function trialsFingerprint(trials: readonly TrialRecord[]): string {
  return [...trials]
    .map((t) => `${t.id}:${t.createdAt}:${t.notes ?? ""}:${t.boxHeightIn}:${t.jumpType}`)
    .sort()
    .join("|");
}

export function deletedIdsFingerprint(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}

export function trialsToRemoteJson(
  trials: readonly TrialRecord[],
  updatedAt = new Date().toISOString(),
  deletedIds: readonly string[] = [],
): string {
  const payload: RemoteLogPayload = {
    trials: [...trials],
    updatedAt,
    deletedIds: [...deletedIds],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseRemotePayload(text: string): {
  trials: TrialRecord[];
  deletedIds: string[];
} {
  try {
    const data = JSON.parse(text) as Partial<RemoteLogPayload> | TrialRecord[];
    if (Array.isArray(data)) {
      return { trials: data.filter(isLooseTrial), deletedIds: [] };
    }
    if (data && Array.isArray(data.trials)) {
      const deletedIds = Array.isArray(data.deletedIds)
        ? data.deletedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      return { trials: data.trials.filter(isLooseTrial), deletedIds };
    }
    return { trials: [], deletedIds: [] };
  } catch {
    return { trials: [], deletedIds: [] };
  }
}

export function parseRemoteJson(text: string): TrialRecord[] {
  return parseRemotePayload(text).trials;
}

function isLooseTrial(value: unknown): value is TrialRecord {
  if (!value || typeof value !== "object") return false;
  const t = value as TrialRecord;
  return (
    typeof t.id === "string" &&
    typeof t.createdAt === "string" &&
    (t.jumpType === "drop" ||
      t.jumpType === "depth" ||
      t.jumpType === "oneStep" ||
      t.jumpType === "penultimate") &&
    typeof t.boxHeightIn === "number" &&
    typeof t.gctMs === "number" &&
    typeof t.heightIn === "number" &&
    typeof t.rsi === "number"
  );
}

function apiUrl(path: string): string {
  return `https://api.github.com/repos/${GITHUB_REPO}${path}`;
}

async function githubJson<T>(
  fetchImpl: GitHubFetch,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T | null; raw: string }> {
  const response = await fetchImpl(apiUrl(path), {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const raw = await response.text();
  let data: T | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data, raw };
}

function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeContent(b64: string): string {
  const clean = b64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function ensureDataBranch(
  token: string,
  fetchImpl: GitHubFetch = fetch.bind(globalThis),
): Promise<void> {
  const existing = await githubJson<{ object?: { sha?: string } }>(
    fetchImpl,
    token,
    `/git/ref/heads/${GITHUB_DATA_BRANCH}`,
  );
  if (existing.ok) return;
  const main = await githubJson<{ object?: { sha?: string } }>(
    fetchImpl,
    token,
    `/git/ref/heads/main`,
  );
  const sha = main.data?.object?.sha;
  if (!main.ok || !sha) throw new Error("Could not read main branch tip for data branch.");
  const created = await githubJson(
    fetchImpl,
    token,
    `/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${GITHUB_DATA_BRANCH}`, sha }),
    },
  );
  if (!created.ok && created.status !== 422) {
    throw new Error(`Could not create data branch (${created.status}).`);
  }
}

async function getFile(
  token: string,
  path: string,
  fetchImpl: GitHubFetch,
): Promise<{ sha: string | null; text: string }> {
  const result = await githubJson<{ sha?: string; content?: string }>(
    fetchImpl,
    token,
    `/contents/${path}?ref=${GITHUB_DATA_BRANCH}`,
  );
  if (result.status === 404) return { sha: null, text: "" };
  if (!result.ok) throw new Error(`Read ${path} failed (${result.status}).`);
  const text = result.data?.content ? decodeContent(result.data.content) : "";
  return { sha: result.data?.sha ?? null, text };
}

async function putFile(
  token: string,
  path: string,
  text: string,
  sha: string | null,
  message: string,
  fetchImpl: GitHubFetch,
): Promise<string | null> {
  const body: Record<string, string> = {
    message,
    content: encodeContent(text),
    branch: GITHUB_DATA_BRANCH,
  };
  if (sha) body.sha = sha;
  const result = await githubJson<{ content?: { sha?: string } }>(fetchImpl, token, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!result.ok) throw new Error(`Write ${path} failed (${result.status}).`);
  return result.data?.content?.sha ?? null;
}

export interface SyncGithubResult {
  /** Trials that should be kept in the local cache after this sync. */
  merged: TrialRecord[];
  pulled: number;
  pushed: boolean;
  /** True when local changed during the push; caller should sync again. */
  needsRepush: boolean;
  error?: string;
}

/**
 * GitHub `data` branch is the source of truth. localStorage is a cache/outbox.
 * Every sync fetches remote first, unions trials by id, and unions deletedIds
 * tombstones — a stale tab can never drop remote-only rows by omission.
 * Never logs the token.
 */
export async function syncGithubLog(options: {
  token: string;
  getLocalTrials: () => readonly TrialRecord[];
  storage: KeyValueStore;
  fetchImpl?: GitHubFetch;
  maxRetries?: number;
}): Promise<SyncGithubResult> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const maxRetries = options.maxRetries ?? 2;
  const token = options.token.trim();
  if (!token) {
    return {
      merged: [...options.getLocalTrials()],
      pulled: 0,
      pushed: false,
      needsRepush: false,
      error: "Add a GitHub token.",
    };
  }

  try {
    await ensureDataBranch(token, fetchImpl);
    let remoteFile = await getFile(token, GITHUB_JSON_PATH, fetchImpl);
    let remotePayload = parseRemotePayload(remoteFile.text);
    const localBefore = options.getLocalTrials();
    const localDeleted = loadDeletedIds(options.storage);

    const buildMerged = (local: readonly TrialRecord[], deletedLocal: readonly string[]) => {
      const deletedIds = mergeDeletedIds(deletedLocal, remotePayload.deletedIds);
      const merged = applyTombstones(mergeTrials(local, remotePayload.trials), deletedIds);
      return { merged, deletedIds };
    };

    let { merged: toPush, deletedIds: deletedToPush } = buildMerged(localBefore, localDeleted);
    const pulled = Math.max(
      0,
      toPush.filter((r) => !localBefore.some((l) => l.id === r.id)).length,
    );

    let attempt = 0;
    let csvSha = (await getFile(token, GITHUB_CSV_PATH, fetchImpl)).sha;
    let jsonSha = remoteFile.sha;
    while (attempt <= maxRetries) {
      try {
        // Re-read outbox immediately before encoding so mid-sync saves/deletes are included.
        const latestLocal = options.getLocalTrials();
        const latestDeleted = loadDeletedIds(options.storage);
        ({ merged: toPush, deletedIds: deletedToPush } = buildMerged(latestLocal, latestDeleted));

        const updatedAt = new Date().toISOString();
        const csv = buildCsvText(toPush);
        const json = trialsToRemoteJson(toPush, updatedAt, deletedToPush);
        jsonSha = (await putFile(
          token,
          GITHUB_JSON_PATH,
          json,
          jsonSha,
          `Update jump log JSON (${toPush.length})`,
          fetchImpl,
        )) ?? jsonSha;
        csvSha = (await putFile(
          token,
          GITHUB_CSV_PATH,
          csv,
          csvSha,
          `Update jump log CSV (${toPush.length})`,
          fetchImpl,
        )) ?? csvSha;

        const afterLocal = options.getLocalTrials();
        const afterDeleted = loadDeletedIds(options.storage);
        const changedDuringPush =
          trialsFingerprint(afterLocal) !== trialsFingerprint(latestLocal) ||
          deletedIdsFingerprint(afterDeleted) !== deletedIdsFingerprint(latestDeleted);
        if (changedDuringPush) {
          saveDeletedIds(options.storage, deletedToPush);
          saveSyncMeta(options.storage, {
            dirty: true,
            lastSyncedAt: updatedAt,
            lastError: null,
            mergedOnce: true,
          });
          return {
            merged: applyTombstones(
              mergeTrials(afterLocal, remotePayload.trials),
              mergeDeletedIds(afterDeleted, remotePayload.deletedIds),
            ),
            pulled,
            pushed: true,
            needsRepush: true,
          };
        }

        saveDeletedIds(options.storage, deletedToPush);
        saveSyncMeta(options.storage, {
          dirty: false,
          lastSyncedAt: updatedAt,
          lastError: null,
          mergedOnce: true,
        });
        return {
          merged: toPush,
          pulled,
          pushed: true,
          needsRepush: false,
        };
      } catch (error) {
        attempt += 1;
        if (attempt > maxRetries) throw error;
        // Remote may have moved — re-fetch so the next merge sees the latest tip.
        remoteFile = await getFile(token, GITHUB_JSON_PATH, fetchImpl);
        remotePayload = parseRemotePayload(remoteFile.text);
        csvSha = (await getFile(token, GITHUB_CSV_PATH, fetchImpl)).sha;
        jsonSha = remoteFile.sha;
      }
    }
    return {
      merged: [...options.getLocalTrials()],
      pulled: 0,
      pushed: false,
      needsRepush: false,
      error: "Sync failed after retries.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const meta = loadSyncMeta(options.storage);
    saveSyncMeta(options.storage, { ...meta, dirty: true, lastError: message });
    return {
      merged: [...options.getLocalTrials()],
      pulled: 0,
      pushed: false,
      needsRepush: false,
      error: message,
    };
  }
}
