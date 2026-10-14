import { describe, expect, it } from "vitest";
import {
  enqueueTrial,
  loadExcelQueue,
  markSynced,
  pendingDropIds,
  saveExcelQueue,
  syncedIds,
  syncStatusFor,
} from "./excelQueue.ts";
import { syncPendingDrops } from "./excelSync.ts";
import type { TrialRecord } from "./storage.ts";

function memoryStore(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

function trial(id: string, jumpType: "drop" | "depth" = "drop"): TrialRecord {
  return {
    id,
    createdAt: "2026-10-14T12:00:00",
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

describe("excel outbox queue", () => {
  it("queues drop jumps as pending and depth as blocked", () => {
    let state = enqueueTrial({ items: [] }, trial("d1", "drop"));
    state = enqueueTrial(state, trial("p1", "depth"));
    state = enqueueTrial(state, trial("d1", "drop"));
    expect(state.items).toHaveLength(2);
    expect(pendingDropIds(state)).toEqual(["d1"]);
    expect(syncStatusFor(state, "p1")).toBe("blocked");
  });

  it("marks synced ids so they are not pending", () => {
    let state = enqueueTrial({ items: [] }, trial("d1"));
    state = markSynced(state, "d1", "2026-10-14T13:00:00Z");
    expect(syncedIds(state).has("d1")).toBe(true);
    expect(pendingDropIds(state)).toEqual([]);
  });
});

describe("syncPendingDrops with mocked Graph", () => {
  it("appends only pending drops and records synced ids", async () => {
    const storage = memoryStore();
    let state = enqueueTrial({ items: [] }, trial("d1"));
    state = enqueueTrial(state, trial("d2"));
    state = markSynced(state, "d2");
    saveExcelQueue(storage, state);

    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("workbook/worksheets")) {
        return new Response(JSON.stringify({ values: [["taken"], [null]] }), { status: 200 });
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify({ values: [] }), { status: 200 });
      }
      // drive item by path
      return new Response(JSON.stringify({ id: "item1" }), { status: 200 });
    };

    const result = await syncPendingDrops({
      token: "tok",
      trials: [trial("d1"), trial("d2")],
      storage,
      fetchImpl,
    });
    expect(result.wrote).toBe(1);
    expect(result.errors).toEqual([]);
    const next = loadExcelQueue(storage);
    expect(pendingDropIds(next)).toEqual([]);
    expect(syncedIds(next).has("d1")).toBe(true);
    expect(syncedIds(next).has("d2")).toBe(true);
  });
});
