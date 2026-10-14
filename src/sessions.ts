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

export interface BoxProfilePoint {
  boxHeightIn: number;
  /** Mean of the session group at this box (or week mean). */
  value: number;
  count: number;
  day: string;
  jumpType: JumpType;
}

export interface BoxProfileSeries {
  /** Week start YYYY-MM-DD (Monday local) or session day. */
  label: string;
  jumpType: JumpType;
  points: BoxProfilePoint[];
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
 * Mean metric vs box height, one series per week (and jump type).
 * Points are sorted by box height.
 */
export function boxProfileByWeek(
  trials: readonly TrialRecord[],
  metric: SessionMetric,
  jumpType?: JumpType,
): BoxProfileSeries[] {
  const sessions = groupSessions(trials).filter(
    (group) => jumpType === undefined || group.jumpType === jumpType,
  );
  const byWeek = new Map<string, SessionGroup[]>();
  for (const group of sessions) {
    const key = `${weekKey(group.day)}|${group.jumpType}`;
    const list = byWeek.get(key);
    if (list) list.push(group);
    else byWeek.set(key, [group]);
  }

  const series: BoxProfileSeries[] = [];
  for (const [key, groups] of byWeek) {
    const [label, type] = key.split("|");
    // Same box in one week: average the session means (multi-day testing).
    const byBox = new Map<number, SessionGroup[]>();
    for (const group of groups) {
      const list = byBox.get(group.boxHeightIn);
      if (list) list.push(group);
      else byBox.set(group.boxHeightIn, [group]);
    }
    const points: BoxProfilePoint[] = [...byBox.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([boxHeightIn, boxGroups]) => ({
        boxHeightIn,
        value: mean(boxGroups.map((g) => g.mean[metric])),
        count: boxGroups.reduce((sum, g) => sum + g.count, 0),
        day: boxGroups[0]!.day,
        jumpType: type as JumpType,
      }));
    series.push({ label, jumpType: type as JumpType, points });
  }

  return series.sort((a, b) => {
    if (a.label !== b.label) return a.label < b.label ? 1 : -1;
    return a.jumpType === "drop" ? -1 : 1;
  });
}
