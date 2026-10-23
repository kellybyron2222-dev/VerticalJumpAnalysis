import type { JumpType, TrialRecord } from "./storage.ts";

export type SessionMetric = "heightIn" | "gctMs" | "flightMs" | "rsi";

export interface SessionGroup {
  /** Local calendar day YYYY-MM-DD */
  day: string;
  jumpType: JumpType;
  boxHeightIn: number;
  jumps: TrialRecord[];
  count: number;
  mean: Record<SessionMetric, number>;
  best: Record<SessionMetric, number>;
}

export interface DateSeriesPoint {
  day: string;
  /** Session mean for that date + box. */
  value: number;
  best: number;
  count: number;
}

/** One box height over time (session means by date). */
export interface BoxDateSeries {
  boxHeightIn: number;
  points: DateSeriesPoint[];
}

/** Local calendar day for a saved jump. */
export function trialDay(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return dayKey(now);
  }
  return dayKey(date);
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Monday-start ISO-like week key from a local day string. */
export function weekKey(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = (date.getDay() + 6) % 7; // Mon=0
  date.setDate(date.getDate() - weekday);
  return dayKey(date);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Best = highest height/RSI, lowest contact/flight time. */
export function bestOf(metric: SessionMetric, values: number[]): number {
  if (values.length === 0) return 0;
  if (metric === "gctMs" || metric === "flightMs") return Math.min(...values);
  return Math.max(...values);
}

function metricsFrom(jumps: TrialRecord[]): {
  mean: Record<SessionMetric, number>;
  best: Record<SessionMetric, number>;
} {
  const height = jumps.map((j) => j.heightIn);
  const gct = jumps.map((j) => j.gctMs);
  const flight = jumps.map((j) => j.flightMs);
  const rsi = jumps.map((j) => j.rsi);
  return {
    mean: {
      heightIn: mean(height),
      gctMs: mean(gct),
      flightMs: mean(flight),
      rsi: mean(rsi),
    },
    best: {
      heightIn: bestOf("heightIn", height),
      gctMs: bestOf("gctMs", gct),
      flightMs: bestOf("flightMs", flight),
      rsi: bestOf("rsi", rsi),
    },
  };
}

/**
 * One session cell: same local day + jump type + box height.
 * Newest days first; within a day, drop before depth, then lower boxes.
 */
export function groupSessions(trials: readonly TrialRecord[]): SessionGroup[] {
  const buckets = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const day = trialDay(trial.createdAt);
    const key = `${day}|${trial.jumpType}|${trial.boxHeightIn}`;
    const list = buckets.get(key);
    if (list) list.push(trial);
    else buckets.set(key, [trial]);
  }

  const groups: SessionGroup[] = [];
  for (const [key, jumps] of buckets) {
    const [day, jumpType, boxText] = key.split("|");
    const boxHeightIn = Number(boxText);
    const ordered = [...jumps].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const { mean: meanMetrics, best } = metricsFrom(ordered);
    groups.push({
      day,
      jumpType: jumpType as JumpType,
      boxHeightIn,
      jumps: ordered,
      count: ordered.length,
      mean: meanMetrics,
      best,
    });
  }

  return groups.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    if (a.jumpType !== b.jumpType) return a.jumpType === "drop" ? -1 : 1;
    return a.boxHeightIn - b.boxHeightIn;
  });
}

/** Session groups for one local calendar day (defaults to today). */
export function sessionsForDay(
  trials: readonly TrialRecord[],
  day = dayKey(new Date()),
): SessionGroup[] {
  return groupSessions(trials).filter((group) => group.day === day);
}

/**
 * Session-mean metric over dates, one series per box height.
 * Points are sorted by date ascending for line charts.
 */
export function metricByDate(
  trials: readonly TrialRecord[],
  metric: SessionMetric,
  jumpType?: JumpType,
): BoxDateSeries[] {
  const sessions = groupSessions(trials).filter(
    (group) => jumpType === undefined || group.jumpType === jumpType,
  );

  // day|box → accumulate (when jump type is "all", merge types on the same day/box)
  const cells = new Map<string, { day: string; boxHeightIn: number; means: number[]; bests: number[]; count: number }>();
  for (const group of sessions) {
    const key = `${group.day}|${group.boxHeightIn}`;
    const cell = cells.get(key);
    if (cell) {
      cell.means.push(group.mean[metric]);
      cell.bests.push(group.best[metric]);
      cell.count += group.count;
    } else {
      cells.set(key, {
        day: group.day,
        boxHeightIn: group.boxHeightIn,
        means: [group.mean[metric]],
        bests: [group.best[metric]],
        count: group.count,
      });
    }
  }

  const byBox = new Map<number, DateSeriesPoint[]>();
  for (const cell of cells.values()) {
    const point: DateSeriesPoint = {
      day: cell.day,
      value: mean(cell.means),
      best: bestOf(metric, cell.bests),
      count: cell.count,
    };
    const list = byBox.get(cell.boxHeightIn);
    if (list) list.push(point);
    else byBox.set(cell.boxHeightIn, [point]);
  }

  return [...byBox.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([boxHeightIn, points]) => ({
      boxHeightIn,
      points: points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    }));
}

/**
 * One point per saved jump (not session mean), colored/grouped by box height.
 * Same BoxDateSeries shape so the chart can reuse lines + legend.
 */
export function metricEveryJump(
  trials: readonly TrialRecord[],
  metric: SessionMetric,
  jumpType?: JumpType,
): BoxDateSeries[] {
  const filtered = trials.filter(
    (t) => jumpType === undefined || t.jumpType === jumpType,
  );
  const byBox = new Map<number, DateSeriesPoint[]>();
  const ordered = [...filtered].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  for (const trial of ordered) {
    const day = trialDay(trial.createdAt);
    const value = trial[metric];
    const point: DateSeriesPoint = {
      day,
      value,
      best: value,
      count: 1,
    };
    const list = byBox.get(trial.boxHeightIn);
    if (list) list.push(point);
    else byBox.set(trial.boxHeightIn, [point]);
  }
  return [...byBox.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([boxHeightIn, points]) => ({ boxHeightIn, points }));
}
