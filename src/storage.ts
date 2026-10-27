import { computeTrialMetrics } from "./metrics.ts";

export const STORAGE_KEY = "jumpLab.trials.v1";

export type JumpType = "drop" | "depth" | "oneStep" | "penultimate";

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
  /** Optimal-box test session id, when this jump was recorded in Box test mode. */
  boxTestId?: string;
  /** Multi-jump clip set id, when saved from a multi-jump analysis. */
  setId?: string;
  /** Penultimate foot touchdown (approach), when marked. */
  penultimateTouchdownFrame?: number;
  /** Penultimate foot toe-off (approach), when marked. */
  penultimateTakeoffFrame?: number;
  /** Penultimate contact time (ms), when both penultimate marks exist. */
  penultimateGctMs?: number;
  /** Gap from penultimate toe-off to plant touchdown (ms). */
  stepGapMs?: number;
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
  boxTestId?: string;
  setId?: string;
  frameTimes?: readonly number[];
  id?: string;
  createdAt?: string;
  penultimateTouchdownFrame?: number | null;
  penultimateTakeoffFrame?: number | null;
  penultimateGctMs?: number | null;
  stepGapMs?: number | null;
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
    (record.jumpType === "drop" ||
      record.jumpType === "depth" ||
      record.jumpType === "oneStep" ||
      record.jumpType === "penultimate") &&
    isFiniteNumber(record.boxHeightIn) &&
    (record.jumpType === "oneStep" || record.jumpType === "penultimate"
      ? record.boxHeightIn >= 0
      : record.boxHeightIn > 0) &&
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
    slowMoFactor: input.slowMoFactor,
    frameTimes: input.frameTimes,
  });
  if (!metrics) return null;
  const approach = input.jumpType === "oneStep" || input.jumpType === "penultimate";
  if (!Number.isFinite(input.boxHeightIn) || (approach ? input.boxHeightIn < 0 : input.boxHeightIn <= 0)) {
    return null;
  }
  if (
    input.jumpType !== "drop" &&
    input.jumpType !== "depth" &&
    input.jumpType !== "oneStep" &&
    input.jumpType !== "penultimate"
  ) {
    return null;
  }

  const extra: Pick<
    TrialRecord,
    | "slowMoFactor"
    | "stepOffFrame"
    | "boxTestId"
    | "setId"
    | "penultimateTouchdownFrame"
    | "penultimateTakeoffFrame"
    | "penultimateGctMs"
    | "stepGapMs"
  > = {};
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
  if (typeof input.boxTestId === "string" && input.boxTestId.length > 0) {
    extra.boxTestId = input.boxTestId;
  }
  if (typeof input.setId === "string" && input.setId.length > 0) {
    extra.setId = input.setId;
  }
  if (
    typeof input.penultimateTouchdownFrame === "number" &&
    Number.isInteger(input.penultimateTouchdownFrame) &&
    input.penultimateTouchdownFrame >= 0
  ) {
    extra.penultimateTouchdownFrame = input.penultimateTouchdownFrame;
  }
  if (
    typeof input.penultimateTakeoffFrame === "number" &&
    Number.isInteger(input.penultimateTakeoffFrame) &&
    input.penultimateTakeoffFrame >= 0
  ) {
    extra.penultimateTakeoffFrame = input.penultimateTakeoffFrame;
  }
  if (input.penultimateGctMs != null && Number.isFinite(input.penultimateGctMs)) {
    extra.penultimateGctMs = input.penultimateGctMs;
  }
  if (input.stepGapMs != null && Number.isFinite(input.stepGapMs)) {
    extra.stepGapMs = input.stepGapMs;
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
