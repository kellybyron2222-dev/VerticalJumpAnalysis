import { describe, expect, it } from "vitest";
import { buildCsvText, MASTER_LOG_HEADERS } from "./masterLog.ts";
import {
  mergeTrials,
  parseRemoteJson,
  syncGithubLog,
  trialsToRemoteJson,
} from "./githubSync.ts";
import type { TrialRecord } from "./storage.ts";

function trial(id: string, createdAt: string, jumpType: "drop" | "depth" = "drop"): TrialRecord {
  return {
    id,
    createdAt,
    fps: 170,
    jumpType,
    boxHeightIn: 12,
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
  };
}

describe("github log merge + CSV", () => {
  it("merges by id and restores remote-only rows", () => {
    const local = [trial("a", "2026-10-14T12:00:00")];
    const remote = [
      trial("a", "2026-10-13T12:00:00"), // older → keep local
      trial("b", "2026-10-10T12:00:00", "depth"),
    ];
    const merged = mergeTrials(local, remote);
    expect(merged.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(merged.find((t) => t.id === "a")!.createdAt).toBe("2026-10-14T12:00:00");
  });

  it("round-trips JSON payload and CSV header order", () => {
    const trials = [trial("a", "2026-10-14T12:00:00")];
    const parsed = parseRemoteJson(trialsToRemoteJson(trials));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe("a");
    const csv = buildCsvText(trials);
    expect(csv.split("\n")[0]).toBe(MASTER_LOG_HEADERS.join(","));
  });

  it("creates data branch and PUTs csv/json with sha retry", async () => {
    const storage = memoryStore();
    const files = new Map<string, { sha: string; text: string }>();
    let puts = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/git/ref/heads/data") && method === "GET") {
        return new Response("{}", { status: 404 });
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

    const result = await syncGithubLog({
      token: "ghs_test",
      localTrials: [trial("local1", "2026-10-14T12:00:00")],
      storage,
      fetchImpl,
      maxRetries: 3,
    });
    expect(result.pushed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(files.get("csv")?.text.split("\n")[0]).toBe(MASTER_LOG_HEADERS.join(","));
    expect(parseRemoteJson(files.get("json")!.text)[0]!.id).toBe("local1");
  });
});
