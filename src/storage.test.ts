import { describe, expect, it } from "vitest";
import { GRAVITY_M_S2 } from "./metrics.ts";
import {
  STORAGE_KEY,
  createTrial,
  loadTrials,
  parseTrials,
  saveTrials,
  type KeyValueStore,
  type TrialRecord,
} from "./storage.ts";

function memoryStore(initial?: string): KeyValueStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  if (initial !== undefined) raw.set(STORAGE_KEY, initial);
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
  };
}

function sample(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    id: "trial-1",
    createdAt: "2026-10-13T18:00:00.000Z",
    fps: 240,
    jumpType: "drop",
    boxHeightIn: 12,
    armSwing: true,
    notes: "felt quick",
    touchdownFrame: 0,
    takeoffFrame: 60,
    landingFrame: 180,
    gctMs: 250,
    flightMs: 500,
    heightM: (GRAVITY_M_S2 * 0.25) / 8,
    heightIn: 12,
    heightCm: 30,
    rsi: 1.2,
    ...overrides,
  };
}

describe("createTrial", () => {
  it("stores the metric math on the record and trims notes", () => {
    const trial = createTrial({
      id: "abc",
      createdAt: "2026-10-13T18:00:00.000Z",
      fps: 240,
      jumpType: "depth",
      boxHeightIn: 18,
      armSwing: false,
      notes: "  quiet landing  ",
      touchdownFrame: 0,
      takeoffFrame: 60,
      landingFrame: 180,
    });
    expect(trial).not.toBeNull();
    if (!trial) return;
    expect(trial.notes).toBe("quiet landing");
    expect(trial.jumpType).toBe("depth");
    expect(trial.gctMs).toBeCloseTo(250, 10);
    expect(trial.flightMs).toBeCloseTo(500, 10);
    expect(trial.heightM).toBeCloseTo((GRAVITY_M_S2 * 0.5 * 0.5) / 8, 10);
    expect(trial.rsi).toBeCloseTo(trial.heightM / 0.25, 10);
  });

  it("stores metrics with the slow-mo factor applied once", () => {
    const trial = createTrial({
      id: "stretched",
      createdAt: "2026-10-13T18:00:00.000Z",
      fps: 240,
      jumpType: "drop",
      boxHeightIn: 6,
      armSwing: false,
      notes: "",
      touchdownFrame: 0,
      takeoffFrame: 120,
      landingFrame: 240,
      slowMoFactor: 2,
    });
    expect(trial).not.toBeNull();
    expect(trial!.gctMs).toBeCloseTo(250, 6);
    expect(trial!.flightMs).toBeCloseTo(250, 6);
    expect(trial!.slowMoFactor).toBe(2);
  });

  it("refuses a trial that is not a real jump", () => {
    expect(
      createTrial({
        fps: 240,
        jumpType: "drop",
        boxHeightIn: 12,
        armSwing: true,
        notes: "",
        touchdownFrame: 10,
        takeoffFrame: 10,
        landingFrame: 20,
      }),
    ).toBeNull();
    expect(
      createTrial({
        fps: 240,
        jumpType: "drop",
        boxHeightIn: 0,
        armSwing: true,
        notes: "",
        touchdownFrame: 0,
        takeoffFrame: 10,
        landingFrame: 20,
      }),
    ).toBeNull();
  });
});

describe("local trial storage", () => {
  it("round-trips trials and drops corrupt entries", () => {
    const store = memoryStore();
    const older = sample({ id: "older", createdAt: "2026-10-01T12:00:00.000Z" });
    const newer = sample({ id: "newer", createdAt: "2026-10-13T12:00:00.000Z" });
    expect(saveTrials([older, newer], store)).toBe(true);
    expect(loadTrials(store).map((trial) => trial.id)).toEqual(["newer", "older"]);

    store.setItem(
      STORAGE_KEY,
      JSON.stringify([newer, { id: "bad" }, "nope", older]),
    );
    expect(loadTrials(store).map((trial) => trial.id)).toEqual(["newer", "older"]);
  });

  it("returns an empty list for missing or broken storage", () => {
    expect(parseTrials(null)).toEqual([]);
    expect(parseTrials("not json")).toEqual([]);
    expect(parseTrials('{"no":"array"}')).toEqual([]);
    expect(loadTrials(memoryStore())).toEqual([]);

    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadTrials(throwing)).toEqual([]);
    expect(saveTrials([sample()], throwing)).toBe(false);
  });
});
