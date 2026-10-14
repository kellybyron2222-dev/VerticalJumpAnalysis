import type { CellBaseline, MetricBaseline, WeeklyMean } from "./baseline.ts";
import { boxTestProfileDays } from "./boxTest.ts";
import { trialDay } from "./sessions.ts";
import type { JumpType, TrialRecord } from "./storage.ts";

export const DEFAULT_GCT_TARGET_MS = 250;
export const GCT_TARGET_STORAGE_KEY = "jumpLab.gctTargetMs.v1";
export const PROFILE_RETEST_WEEKS = 4;
export const PROFILE_BOX_COUNT = 3;

export type RaiseSignal = "ready" | "hold" | "none";

export interface RaiseBoxResult {
  signal: RaiseSignal;
  /** Short reason for the session view. */
  reason: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadGctTargetMs(storage: KeyValueStore): number {
  try {
    const raw = storage.getItem(GCT_TARGET_STORAGE_KEY);
    if (raw === null) return DEFAULT_GCT_TARGET_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_GCT_TARGET_MS;
    return value;
  } catch {
    return DEFAULT_GCT_TARGET_MS;
  }
}

export function saveGctTargetMs(storage: KeyValueStore, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    storage.setItem(GCT_TARGET_STORAGE_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}

/** Relative delta of a weekly mean vs baseline. */
export function weekDelta(mean: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(mean)) return null;
  return (mean - baseline) / baseline;
}

/** RSI more than 1× CV above baseline. */
export function rsiAboveNoise(delta: number | null, cv: number): boolean {
  return delta !== null && cv > 0 && delta > cv;
}

/** Contact trending worse: watch/real flag with positive delta (higher GCT). */
export function contactTrendingWorse(gct: MetricBaseline): boolean {
  return (gct.flag === "watch" || gct.flag === "real") && gct.delta !== null && gct.delta > 0;
}

/**
 * Ready when RSI is > 1× CV above baseline for this week and the prior week,
 * and both weeks' contact means are at or under the target.
 * Hold when contact is above target or trending up (worse).
 */
export function raiseBoxSignal(
  cell: CellBaseline,
  gctTargetMs: number,
): RaiseBoxResult {
  const rsi = cell.metrics.rsi;
  const gct = cell.metrics.gctMs;
  if (!rsi.baseline || !rsi.currentWeek || rsi.priorWeeks.length === 0) {
    return { signal: "none", reason: "Raise box · need more weeks" };
  }

  const prevRsi = rsi.priorWeeks[rsi.priorWeeks.length - 1]!;
  const prevGct = gct.priorWeeks[gct.priorWeeks.length - 1];
  const curGct = gct.currentWeek;

  const curRsiDelta = weekDelta(rsi.currentWeek.mean, rsi.baseline);
  const prevRsiDelta = weekDelta(prevRsi.mean, rsi.baseline);
  const rsiTwoWeeks =
    rsiAboveNoise(curRsiDelta, rsi.cv) && rsiAboveNoise(prevRsiDelta, rsi.cv);

  const gctCurrentOk = curGct !== null && curGct.mean <= gctTargetMs;
  const gctPrevOk = prevGct !== undefined && prevGct.mean <= gctTargetMs;
  const gctAboveTarget = curGct !== null && curGct.mean > gctTargetMs;
  const gctWorse = contactTrendingWorse(gct);

  if (gctAboveTarget || gctWorse) {
    return {
      signal: "hold",
      reason: gctWorse
        ? "Raise box · hold (contact trending up)"
        : `Raise box · hold (contact > ${gctTargetMs} ms)`,
    };
  }

  if (rsiTwoWeeks && gctCurrentOk && gctPrevOk) {
    return { signal: "ready", reason: "Raise box · ready" };
  }

  if (rsiTwoWeeks && !gctPrevOk) {
    return { signal: "hold", reason: "Raise box · hold (prior week contact high)" };
  }

  return { signal: "none", reason: "Raise box · not yet" };
}

/** Local days where this jump type hit at least `minBoxes` distinct box heights (or a box test). */
export function fullProfileDays(
  trials: readonly TrialRecord[],
  jumpType?: JumpType,
  minBoxes = PROFILE_BOX_COUNT,
): string[] {
  const byDay = new Map<string, Set<number>>();
  for (const trial of trials) {
    if (jumpType && trial.jumpType !== jumpType) continue;
    const day = trialDay(trial.createdAt);
    const set = byDay.get(day) ?? new Set<number>();
    set.add(trial.boxHeightIn);
    byDay.set(day, set);
  }
  const fromSessions = [...byDay.entries()]
    .filter(([, boxes]) => boxes.size >= minBoxes)
    .map(([day]) => day);
  const fromTests = boxTestProfileDays(
    jumpType ? trials.filter((t) => t.jumpType === jumpType) : trials,
  );
  return [...new Set([...fromSessions, ...fromTests])].sort();
}

/** Whole weeks between two YYYY-MM-DD day (or week) keys. */
export function wholeWeeksBetween(earlier: string, later: string): number {
  const [y1, m1, d1] = earlier.split("-").map(Number);
  const [y2, m2, d2] = later.split("-").map(Number);
  const a = Date.UTC(y1!, m1! - 1, d1!);
  const b = Date.UTC(y2!, m2! - 1, d2!);
  if (!(b >= a)) return 0;
  return Math.floor((b - a) / (7 * 24 * 60 * 60 * 1000));
}

export function lastFullProfileDay(
  trials: readonly TrialRecord[],
  jumpType?: JumpType,
): string | null {
  const days = fullProfileDays(trials, jumpType);
  return days.length > 0 ? days[days.length - 1]! : null;
}

/**
 * True when 4+ weeks have passed since the last day with 3+ box heights
 * (or when no such day exists and there is already jump history).
 */
export function needsProfileRetest(
  trials: readonly TrialRecord[],
  asOfDay: string,
  jumpType?: JumpType,
  minWeeks = PROFILE_RETEST_WEEKS,
): { needed: boolean; lastProfileDay: string | null; weeksSince: number | null } {
  const last = lastFullProfileDay(trials, jumpType);
  if (!last) {
    const hasJumps =
      trials.some((t) => jumpType === undefined || t.jumpType === jumpType) && trials.length > 0;
    return {
      needed: hasJumps,
      lastProfileDay: null,
      weeksSince: null,
    };
  }
  const weeks = wholeWeeksBetween(last, asOfDay);
  return { needed: weeks >= minWeeks, lastProfileDay: last, weeksSince: weeks };
}

/** Test helper: build a thin MetricBaseline from weekly rows. */
export function metricFromWeeks(
  metric: "rsi" | "gctMs",
  weeks: readonly WeeklyMean[],
  currentWeek: string,
  baseline: number,
  cv: number,
  flag: MetricBaseline["flag"] = "none",
): MetricBaseline {
  const prior = weeks.filter((w) => w.week < currentWeek);
  const current = weeks.find((w) => w.week === currentWeek) ?? null;
  const delta = current ? weekDelta(current.mean, baseline) : null;
  return {
    metric,
    status: prior.length >= 6 ? "established" : prior.length >= 3 ? "provisional" : "none",
    priorWeeks: prior,
    baseline,
    cv,
    currentWeek: current,
    delta,
    percentChange: delta === null ? null : delta * 100,
    flag,
    pr: current?.best ?? null,
    higherIsBetter: metric !== "gctMs",
  };
}

export function cellFromMetrics(
  jumpType: JumpType,
  boxHeightIn: number,
  week: string,
  rsi: MetricBaseline,
  gctMs: MetricBaseline,
  heightIn: MetricBaseline,
): CellBaseline {
  return {
    jumpType,
    boxHeightIn,
    week,
    metrics: { rsi, gctMs, heightIn },
  };
}
