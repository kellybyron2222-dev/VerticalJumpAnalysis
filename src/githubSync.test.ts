import { describe, expect, it } from "vitest";
import { buildCsvText, MASTER_LOG_HEADERS } from "./masterLog.ts";
import {
  GITHUB_DELETED_IDS_KEY,
  GITHUB_SYNC_META_KEY,
  applyTombstones,
  markDeleted,
  mergeDeletedIds,
  mergeTrials,
  parseRemoteJson,
  parseRemotePayload,
  syncGithubLog,
  trialsToRemoteJson,
} from "./githubSync.ts";
import type { JumpType, TrialRecord } from "./storage.ts";

function trial(
  id: string,
  createdAt: string,
  jumpType: JumpType = "drop",
): TrialRecord {
  return {
    id,
    createdAt,
    fps: 170,
    jumpType,
    boxHeightIn: jumpType === "oneStep" || jumpType === "penultimate" ? 0 : 12,
    armSwing: false,
    notes: "",
    touchdownFrame: 1,
    takeoffFrame: 2,
    landingFrame: 3,
    gctMs: 220,
    flightMs: 500,
    heightM: 0.3,
    heightIn: 12,
    heightCm: 30,
    rsi: 1.4,
  };
}

function memoryStore(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    data,
  };
}

function mockGithub(files: Map<string, { sha: string; text: string }>) {
  let puts = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/git/ref/heads/data") && method === "GET") {
      return new Response(JSON.stringify({ object: { sha: "datasha" } }), { status: 200 });
    }
    if (url.endsWith("/git/ref/heads/main") && method === "GET") {
      return new Response(JSON.stringify({ object: { sha: "mainsha" } }), { status: 200 });
    }
    if (url.endsWith("/git/refs") && method === "POST") {
      return new Response(JSON.stringify({ ref: "refs/heads/data" }), { status: 201 });
    }
    if (url.includes("/contents/data/jump-log") && method === "GET") {
      const path = url.includes("jump-log.json") ? "json" : "csv";
      const hit = files.get(path);
      if (!hit) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({
          sha: hit.sha,
          content: btoa(hit.text),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/contents/data/jump-log") && method === "PUT") {
      puts += 1;
      const path = url.includes("jump-log.json") ? "json" : "csv";
      const body = JSON.parse(String(init?.body ?? "{}")) as { content: string; sha?: string };
      const existing = files.get(path);
      if (existing && body.sha && body.sha !== existing.sha && puts < 3) {
        return new Response("{}", { status: 409 });
      }
      const text = atob(body.content);
      files.set(path, { sha: `sha-${puts}`, text });
      return new Response(JSON.stringify({ content: { sha: `sha-${puts}` } }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  };
  return { fetchImpl, getPuts: () => puts };
}

describe("github log merge + CSV", () => {
  it("merges by id and restores remote-only rows", () => {
    const local = [trial("a", "2026-10-14T12:00:00")];
    const remote = [
      trial("a", "2026-10-13T12:00:00"),
      trial("b", "2026-10-10T12:00:00", "depth"),
    ];
    const merged = mergeTrials(local, remote);
    expect(merged.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(merged.find((t) => t.id === "a")!.createdAt).toBe("2026-10-14T12:00:00");
  });

  it("keeps oneStep and penultimate through remote parse", () => {
    const trials = [
      trial("os", "2026-10-27T23:48:40.548Z", "oneStep"),
      trial("pen", "2026-10-27T23:50:00.000Z", "penultimate"),
    ];
    const parsed = parseRemoteJson(trialsToRemoteJson(trials));
    expect(parsed.map((t) => t.jumpType).sort()).toEqual(["oneStep", "penultimate"]);
  });

  it("applies tombstones and unions deletedIds", () => {
    expect(mergeDeletedIds(["a"], ["b", "a"])).toEqual(["a", "b"]);
    const kept = applyTombstones(
      [trial("a", "2026-10-14T12:00:00"), trial("b", "2026-10-14T12:01:00")],
      ["a"],
    );
    expect(kept.map((t) => t.id)).toEqual(["b"]);
  });

  it("round-trips JSON payload and CSV header order", () => {
    const trials = [trial("a", "2026-10-14T12:00:00")];
    const parsed = parseRemotePayload(trialsToRemoteJson(trials, undefined, ["gone"]));
    expect(parsed.trials).toHaveLength(1);
    expect(parsed.trials[0]!.id).toBe("a");
    expect(parsed.deletedIds).toEqual(["gone"]);
    const csv = buildCsvText(trials);
    expect(csv.split("\n")[0]).toBe(MASTER_LOG_HEADERS.join(","));
  });

  it("dirty save merges remote-only rows instead of overwriting", async () => {
    const storage = memoryStore({
      [GITHUB_SYNC_META_KEY]: JSON.stringify({
        dirty: true,
        lastSyncedAt: null,
        lastError: null,
        mergedOnce: false,
      }),
    });
    const files = new Map<string, { sha: string; text: string }>();
    const remoteOnly = trial("f1068afe", "2026-10-27T23:48:40.548Z", "oneStep");
    files.set("csv", { sha: "csv0", text: `${MASTER_LOG_HEADERS.join(",")}\n` });
    files.set(
      "json",
      { sha: "json0", text: trialsToRemoteJson([remoteOnly, trial("older", "2026-10-10T12:00:00")]) },
    );
    const { fetchImpl } = mockGithub(files);
    const local = [trial("saved1", "2026-10-14T12:00:00")];

    const result = await syncGithubLog({
      token: "ghs_test",
      getLocalTrials: () => local,
      storage,
      fetchImpl,
    });

    expect(result.pushed).toBe(true);
    expect(result.error).toBeUndefined();
    const ids = parseRemoteJson(files.get("json")!.text).map((t) => t.id).sort();
    expect(ids).toEqual(["f1068afe", "older", "saved1"]);
    expect(result.merged.map((t) => t.id).sort()).toEqual(["f1068afe", "older", "saved1"]);
    const csvLines = files.get("csv")!.text.trim().split("\n");
    expect(csvLines[0]).toBe(MASTER_LOG_HEADERS.join(","));
    expect(csvLines.length).toBe(4);
  });

  it("stale client delete without tombstone cannot drop remote-only rows", async () => {
    const storage = memoryStore({
      [GITHUB_SYNC_META_KEY]: JSON.stringify({
        dirty: true,
        lastSyncedAt: null,
        lastError: null,
        mergedOnce: true,
      }),
    });
    const files = new Map<string, { sha: string; text: string }>();
    const remote = [
      trial("keep-me", "2026-10-27T23:48:40.548Z", "oneStep"),
      trial("local-also", "2026-10-14T12:00:00"),
    ];
    files.set("json", { sha: "json0", text: trialsToRemoteJson(remote) });
    files.set("csv", { sha: "csv0", text: buildCsvText(remote) });
    const { fetchImpl } = mockGithub(files);
    // Stale tab only knows about local-also (forgot keep-me).
    const result = await syncGithubLog({
      token: "ghs_test",
      getLocalTrials: () => [trial("local-also", "2026-10-14T12:00:00")],
      storage,
      fetchImpl,
    });
    expect(result.pushed).toBe(true);
    expect(parseRemoteJson(files.get("json")!.text).map((t) => t.id).sort()).toEqual([
      "keep-me",
      "local-also",
    ]);
  });

  it("explicit tombstone deletes a remote row on sync", async () => {
    const storage = memoryStore({
      [GITHUB_SYNC_META_KEY]: JSON.stringify({
        dirty: true,
        lastSyncedAt: null,
        lastError: null,
        mergedOnce: true,
      }),
    });
    markDeleted(storage, "gone");
    expect(JSON.parse(storage.data[GITHUB_DELETED_IDS_KEY]!)).toEqual(["gone"]);
    const files = new Map<string, { sha: string; text: string }>();
    const remote = [
      trial("gone", "2026-10-10T12:00:00"),
      trial("stay", "2026-10-14T12:00:00", "oneStep"),
    ];
    files.set("json", { sha: "json0", text: trialsToRemoteJson(remote) });
    files.set("csv", { sha: "csv0", text: buildCsvText(remote) });
    const { fetchImpl } = mockGithub(files);
    const result = await syncGithubLog({
      token: "ghs_test",
      getLocalTrials: () => [trial("stay", "2026-10-14T12:00:00", "oneStep")],
      storage,
      fetchImpl,
    });
    expect(result.pushed).toBe(true);
    const payload = parseRemotePayload(files.get("json")!.text);
    expect(payload.trials.map((t) => t.id)).toEqual(["stay"]);
    expect(payload.deletedIds).toContain("gone");
  });

  it("re-reads local before PUT so a mid-sync save is included", async () => {
    const storage = memoryStore({
      [GITHUB_SYNC_META_KEY]: JSON.stringify({
        dirty: true,
        lastSyncedAt: null,
        lastError: null,
        mergedOnce: false,
      }),
    });
    const files = new Map<string, { sha: string; text: string }>();
    files.set("json", { sha: "json0", text: trialsToRemoteJson([]) });
    const live = [trial("first", "2026-10-14T12:00:00")];
    const { fetchImpl } = mockGithub(files);
    let reads = 0;
    const result = await syncGithubLog({
      token: "ghs_test",
      getLocalTrials: () => {
        reads += 1;
        if (reads === 2 && !live.some((t) => t.id === "second")) {
          live.push(trial("second", "2026-10-14T12:01:00"));
        }
        return [...live];
      },
      storage,
      fetchImpl,
    });
    expect(result.pushed).toBe(true);
    const ids = parseRemoteJson(files.get("json")!.text).map((t) => t.id);
    expect(ids).toContain("first");
    expect(ids).toContain("second");
  });

  it("heals empty remote from local cache even when not marked dirty", async () => {
    const storage = memoryStore();
    const files = new Map<string, { sha: string; text: string }>();
    files.set("csv", { sha: "csv0", text: `${MASTER_LOG_HEADERS.join(",")}\n` });
    files.set("json", { sha: "json0", text: trialsToRemoteJson([]) });
    const { fetchImpl } = mockGithub(files);
    const result = await syncGithubLog({
      token: "ghs_test",
      getLocalTrials: () => [trial("local1", "2026-10-14T12:00:00")],
      storage,
      fetchImpl,
    });
    expect(result.pushed).toBe(true);
    expect(parseRemoteJson(files.get("json")!.text)[0]!.id).toBe("local1");
    expect(files.get("csv")!.text.trim().split("\n").length).toBe(2);
  });
});
