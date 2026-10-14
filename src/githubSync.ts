import { buildCsvText } from "./masterLog.ts";
import type { KeyValueStore, TrialRecord } from "./storage.ts";

export const GITHUB_TOKEN_KEY = "jumpLab.githubToken.v1";
export const GITHUB_SYNC_META_KEY = "jumpLab.githubSyncMeta.v1";
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

export function trialsToRemoteJson(trials: readonly TrialRecord[], updatedAt = new Date().toISOString()): string {
  const payload: RemoteLogPayload = { trials: [...trials], updatedAt };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseRemoteJson(text: string): TrialRecord[] {
  try {
    const data = JSON.parse(text) as Partial<RemoteLogPayload> | TrialRecord[];
    if (Array.isArray(data)) return data.filter(isLooseTrial);
    if (data && Array.isArray(data.trials)) return data.trials.filter(isLooseTrial);
    return [];
  } catch {
    return [];
  }
}

function isLooseTrial(value: unknown): value is TrialRecord {
  if (!value || typeof value !== "object") return false;
  const t = value as TrialRecord;
  return (
    typeof t.id === "string" &&
    typeof t.createdAt === "string" &&
    (t.jumpType === "drop" || t.jumpType === "depth") &&
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
): Promise<void> {
  const body: Record<string, string> = {
    message,
    content: encodeContent(text),
    branch: GITHUB_DATA_BRANCH,
  };
  if (sha) body.sha = sha;
  const result = await githubJson(fetchImpl, token, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!result.ok) throw new Error(`Write ${path} failed (${result.status}).`);
}

export interface SyncGithubResult {
  merged: TrialRecord[];
  pulled: number;
  pushed: boolean;
  error?: string;
}

/**
 * Ensure data branch, pull/merge remote JSON, push CSV + JSON with sha retry.
 * Never logs the token.
 */
export async function syncGithubLog(options: {
  token: string;
  localTrials: readonly TrialRecord[];
  storage: KeyValueStore;
  fetchImpl?: GitHubFetch;
  maxRetries?: number;
}): Promise<SyncGithubResult> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const maxRetries = options.maxRetries ?? 2;
  const token = options.token.trim();
  if (!token) return { merged: [...options.localTrials], pulled: 0, pushed: false, error: "Add a GitHub token." };

  try {
    await ensureDataBranch(token, fetchImpl);
    const remoteFile = await getFile(token, GITHUB_JSON_PATH, fetchImpl);
    const remoteTrials = parseRemoteJson(remoteFile.text);
    const meta = loadSyncMeta(options.storage);
    const merged = mergeTrials(options.localTrials, remoteTrials);
    const pulled = merged.length - options.localTrials.length > 0
      ? Math.max(0, remoteTrials.filter((r) => !options.localTrials.some((l) => l.id === r.id)).length)
      : 0;

    let attempt = 0;
    let csvSha = (await getFile(token, GITHUB_CSV_PATH, fetchImpl)).sha;
    let jsonSha = remoteFile.sha;
    while (attempt <= maxRetries) {
      try {
        const updatedAt = new Date().toISOString();
        const csv = buildCsvText(merged);
        const json = trialsToRemoteJson(merged, updatedAt);
        await putFile(token, GITHUB_JSON_PATH, json, jsonSha, `Update jump log JSON (${merged.length})`, fetchImpl);
        await putFile(token, GITHUB_CSV_PATH, csv, csvSha, `Update jump log CSV (${merged.length})`, fetchImpl);
        saveSyncMeta(options.storage, {
          dirty: false,
          lastSyncedAt: updatedAt,
          lastError: null,
          mergedOnce: true,
        });
        void meta;
        return { merged, pulled, pushed: true };
      } catch (error) {
        attempt += 1;
        if (attempt > maxRetries) throw error;
        csvSha = (await getFile(token, GITHUB_CSV_PATH, fetchImpl)).sha;
        jsonSha = (await getFile(token, GITHUB_JSON_PATH, fetchImpl)).sha;
      }
    }
    return { merged, pulled, pushed: false, error: "Sync failed after retries." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const meta = loadSyncMeta(options.storage);
    saveSyncMeta(options.storage, { ...meta, lastError: message });
    return { merged: [...options.localTrials], pulled: 0, pushed: false, error: message };
  }
}
