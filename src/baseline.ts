import {
  bestOf,
  trialDay,
  weekKey,
  type SessionMetric,
} from "./sessions.ts";
import type { JumpType, TrialRecord } from "./storage.ts";

export const DEFAULT_CV = 0.085;
export const BASELINE_STORAGE_KEY = "jumpLab.rebaseline.v1";

export type BaselineStatus = "none" | "provisional" | "established";
export type FlagLevel = "none" | "normal" | "watch" | "real";

export type FlagMetric = "heightIn" | "gctMs" | "rsi";

export interface WeeklyMean {
  week: string;
  mean: number;
  best: number;
  count: number;
}

export interface MetricBaseline {
  metric: FlagMetric;
  status: BaselineStatus;
  /** Prior weekly means used for baseline (after re-baseline cut). */
  priorWeeks: WeeklyMean[];
  baseline: number | null;
  cv: number;
  currentWeek: WeeklyMean | null;
  /** Relative change (current − baseline) / baseline. */
  delta: number | null;
  /** Percent change for display. */
  percentChange: number | null;
  flag: FlagLevel;
  /** All-time best for this cell (PR). */
  pr: number | null;
  /** Higher is better for height/RSI; lower is better for contact. */
  higherIsBetter: boolean;
}

export interface CellBaseline {
  jumpType: JumpType;
  boxHeightIn: number;
  week: string;
  metrics: Record<FlagMetric, MetricBaseline>;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function baselineCellKey(jumpType: JumpType, boxHeightIn: number): string {
  return `${jumpType}|${boxHeightIn}`;
}

export function loadRebaselineWeeks(storage: KeyValueStore): Record<string, string> {
  try {
    const raw = storage.getItem(BASELINE_STORAGE_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Pin baseline history to start at `week` (Monday key) for this cell. */
export function setRebaselineWeek(
  storage: KeyValueStore,
  jumpType: JumpType,
  boxHeightIn: number,
  week: string,
): boolean {
  try {
    const map = loadRebaselineWeeks(storage);
    map[baselineCellKey(jumpType, boxHeightIn)] = week;
    storage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function higherIsBetter(metric: FlagMetric): boolean {
  return metric !== "gctMs";
}

export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 3) return DEFAULT_CV;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (!(avg > 0)) return DEFAULT_CV;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) * (v - avg), 0) / (values.length - 1);
  return Math.sqrt(variance) / avg;
}

/** Weekly means for one jump type + box + metric, oldest week first. */
export function weeklyMeans(
  trials: readonly TrialRecord[],
  jumpType: JumpType,
  boxHeightIn: number,
  metric: FlagMetric,
): WeeklyMean[] {
  const buckets = new Map<string, number[]>();
  for (const trial of trials) {
    if (trial.jumpType !== jumpType) continue;
    if (trial.boxHeightIn !== boxHeightIn) continue;
    const week = weekKey(trialDay(trial.createdAt));
    const list = buckets.get(week);
    const value = trial[metric];
    if (list) list.push(value);
    else buckets.set(week, [value]);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, values]) => ({
      week,
      mean: values.reduce((sum, v) => sum + v, 0) / values.length,
      best: bestOf(metric, values),
      count: values.length,
    }));
}

export function baselineStatus(priorWeekCount: number): BaselineStatus {
  if (priorWeekCount >= 6) return "established";
  if (priorWeekCount >= 3) return "provisional";
  return "none";
}

/**
 * Classify change vs baseline. Flags only when established.
 * Contact time: lower is better; consecutive-week rule still uses signed delta.
 */
export function classifyFlag(
  status: BaselineStatus,
  delta: number | null,
  previousDelta: number | null,
  cv: number,
): FlagLevel {
  if (status !== "established" || delta === null || !(cv > 0)) return "none";
  const abs = Math.abs(delta);
  const consecutive =
    previousDelta !== null &&
    Math.abs(previousDelta) > cv &&
    Math.sign(previousDelta) === Math.sign(delta) &&
    Math.sign(delta) !== 0;
  if (abs > 2 * cv || (abs > cv && consecutive)) return "real";
  if (abs > cv) return "watch";
  return "normal";
}

export function evaluateMetric(
  weeks: readonly WeeklyMean[],
  currentWeek: string,
  rebaselineFrom: string | null,
  metric: FlagMetric,
): MetricBaseline {
  const cut = rebaselineFrom;
  const inWindow = cut ? weeks.filter((w) => w.week >= cut) : [...weeks];
  const prior = inWindow.filter((w) => w.week < currentWeek);
  const current = inWindow.find((w) => w.week === currentWeek) ?? null;
  const status = baselineStatus(prior.length);
  const forBaseline =
    status === "established" ? prior.slice(-6) : status === "provisional" ? prior : [];
  const baseline =
    forBaseline.length > 0
      ? forBaseline.reduce((sum, w) => sum + w.mean, 0) / forBaseline.length
      : null;
  const cv = coefficientOfVariation(prior.map((w) => w.mean));
  const delta =
    baseline !== null && current && baseline !== 0
      ? (current.mean - baseline) / baseline
      : null;
  const prev = prior.length > 0 ? prior[prior.length - 1]! : null;
  const previousDelta =
    baseline !== null && prev && baseline !== 0 ? (prev.mean - baseline) / baseline : null;
  const allValues = inWindow.flatMap((w) => {
    // Reconstruct PR from weekly bests (sufficient for display).
    return [w.best];
  });
  const pr = allValues.length > 0 ? bestOf(metric, allValues) : null;

  return {
    metric,
    status,
    priorWeeks: prior,
    baseline,
    cv,
    currentWeek: current,
    delta,
    percentChange: delta === null ? null : delta * 100,
    flag: classifyFlag(status, delta, previousDelta, cv),
    pr,
    higherIsBetter: higherIsBetter(metric),
  };
}

export function evaluateCell(
  trials: readonly TrialRecord[],
  jumpType: JumpType,
  boxHeightIn: number,
  currentWeek: string,
  rebaselineFrom: string | null = null,
): CellBaseline {
  const metrics = {
    heightIn: evaluateMetric(
      weeklyMeans(trials, jumpType, boxHeightIn, "heightIn"),
      currentWeek,
      rebaselineFrom,
      "heightIn",
    ),
    gctMs: evaluateMetric(
      weeklyMeans(trials, jumpType, boxHeightIn, "gctMs"),
      currentWeek,
      rebaselineFrom,
      "gctMs",
    ),
    rsi: evaluateMetric(
      weeklyMeans(trials, jumpType, boxHeightIn, "rsi"),
      currentWeek,
      rebaselineFrom,
      "rsi",
    ),
  };
  return { jumpType, boxHeightIn, week: currentWeek, metrics };
}

export function formatFlag(flag: FlagLevel): string {
  if (flag === "watch") return "watch";
  if (flag === "real") return "real change";
  if (flag === "normal") return "normal";
  return "—";
}

export function formatStatus(status: BaselineStatus): string {
  if (status === "established") return "established";
  if (status === "provisional") return "provisional";
  return "no baseline yet";
}

/** Shared SessionMetric subset used for flags (excludes flight). */
export function isFlagMetric(metric: SessionMetric): metric is FlagMetric {
  return metric === "heightIn" || metric === "gctMs" || metric === "rsi";
}
