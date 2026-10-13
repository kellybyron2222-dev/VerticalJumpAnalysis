import { computeTrialMetrics } from "./metrics.ts";

export const STORAGE_KEY = "jumpLab.trials.v1";

export type JumpType = "drop" | "depth";

export interface TrialRecord {
  id: string;
  createdAt: string;
  fps: number;
  jumpType: JumpType;
  boxHeightIn: number;
  armSwing: boolean;
  notes: string;
  touchdownFrame: number;
  takeoffFrame: number;
  landingFrame: number;
  gctMs: number;
  flightMs: number;
  heightM: number;
  heightIn: number;
  heightCm: number;
  rsi: number;
  /** Media seconds per real second. Missing on older records, which means 1. */
  slowMoFactor?: number;
  /** Last frame on the box, when marked. */
  stepOffFrame?: number;
}

export interface NewTrialInput {
  fps: number;
  jumpType: JumpType;
  boxHeightIn: number;
  armSwing: boolean;
  notes: string;
  touchdownFrame: number;
  takeoffFrame: number;
  landingFrame: number;
  slowMoFactor?: number;
  stepOffFrame?: number | null;
  id?: string;
  createdAt?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFrame(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isTrialRecord(value: unknown): value is TrialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.createdAt === "string" &&
    isFiniteNumber(record.fps) &&
    record.fps > 0 &&
    (record.jumpType === "drop" || record.jumpType === "depth") &&
    isFiniteNumber(record.boxHeightIn) &&
    record.boxHeightIn > 0 &&
    typeof record.armSwing === "boolean" &&
    typeof record.notes === "string" &&
    isFrame(record.touchdownFrame) &&
    isFrame(record.takeoffFrame) &&
    isFrame(record.landingFrame) &&
    record.touchdownFrame < record.takeoffFrame &&
    record.takeoffFrame < record.landingFrame &&
    isFiniteNumber(record.gctMs) &&
    isFiniteNumber(record.flightMs) &&
    isFiniteNumber(record.heightM) &&
    isFiniteNumber(record.heightIn) &&
    isFiniteNumber(record.heightCm) &&
    isFiniteNumber(record.rsi)
  );
}

export function createTrial(input: NewTrialInput): TrialRecord | null {
  const metrics = computeTrialMetrics({
    touchdown: input.touchdownFrame,
    takeoff: input.takeoffFrame,
    landing: input.landingFrame,
    fps: input.fps,
  });
  if (!metrics) return null;
  if (!Number.isFinite(input.boxHeightIn) || input.boxHeightIn <= 0) return null;
  if (input.jumpType !== "drop" && input.jumpType !== "depth") return null;

  const extra: Pick<TrialRecord, "slowMoFactor" | "stepOffFrame"> = {};
  if (input.slowMoFactor !== undefined && Number.isFinite(input.slowMoFactor) && input.slowMoFactor > 0) {
    extra.slowMoFactor = input.slowMoFactor;
  }
  if (
    typeof input.stepOffFrame === "number" &&
    Number.isInteger(input.stepOffFrame) &&
    input.stepOffFrame >= 0 &&
    input.stepOffFrame < input.touchdownFrame
  ) {
    extra.stepOffFrame = input.stepOffFrame;
  }

  return {
    ...extra,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    fps: input.fps,
    jumpType: input.jumpType,
    boxHeightIn: input.boxHeightIn,
    armSwing: input.armSwing,
    notes: input.notes.trim(),
    touchdownFrame: input.touchdownFrame,
    takeoffFrame: input.takeoffFrame,
    landingFrame: input.landingFrame,
    gctMs: metrics.gctMs,
    flightMs: metrics.flightMs,
    heightM: metrics.heightM,
    heightIn: metrics.heightIn,
    heightCm: metrics.heightCm,
    rsi: metrics.rsi,
  };
}

export function parseTrials(raw: string | null): TrialRecord[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isTrialRecord).sort((a, b) => {
      if (a.createdAt === b.createdAt) return 0;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  } catch {
    return [];
  }
}

export function loadTrials(storage: KeyValueStore): TrialRecord[] {
  try {
    return parseTrials(storage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveTrials(trials: TrialRecord[], storage: KeyValueStore): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(trials));
    return true;
  } catch {
    return false;
  }
}
