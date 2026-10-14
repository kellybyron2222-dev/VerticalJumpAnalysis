import { previewMetrics } from "./metrics.ts";
import { sloMoStretch, type SloMoHint } from "./timing.ts";
import type { DetectedEvents } from "./detect.ts";

export interface TimeRegion {
  startFrame: number;
  endFrame: number;
  startTime: number;
  endTime: number;
}

export interface MultiJumpRow {
  index: number;
  events: DetectedEvents;
  include: boolean;
  outsideSlow: boolean;
  gctMs: number | null;
  flightMs: number | null;
  heightIn: number | null;
  rsi: number | null;
}

export interface SetSummary {
  count: number;
  meanHeightIn: number | null;
  bestHeightIn: number | null;
  meanGctMs: number | null;
  bestGctMs: number | null;
  meanRsi: number | null;
  bestRsi: number | null;
}

/** Create a short set id for tagging saved jumps from one multi-jump clip. */
export function createSetId(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `set-${y}${m}${d}-${hh}${mm}${ss}`;
}

/**
 * Presentation-time regions that look like iPhone slo-mo holds (~1/60 + 1/30).
 * A clip that is entirely slo-mo yields one region covering the whole file.
 */
export function slowedRegions(times: readonly number[], hint: SloMoHint = {}): TimeRegion[] {
  if (times.length < 8) return [];
  const stretch = sloMoStretch(times, hint);
  if (stretch <= 1) {
    // No global slo-mo signature — look for local high short-gap density anyway.
  }
  const dts: number[] = [];
  for (let i = 1; i < times.length; i += 1) dts.push(times[i]! - times[i - 1]!);

  const win = 45;
  const slowAt: boolean[] = [];
  for (let i = 0; i < dts.length; i += 1) {
    const from = Math.max(0, i - win);
    const to = Math.min(dts.length, i + win + 1);
    let short = 0;
    let n = 0;
    for (let k = from; k < to; k += 1) {
      n += 1;
      if (dts[k]! > 0 && dts[k]! <= 0.025) short += 1;
    }
    const frac = n ? short / n : 0;
    // Held slo-mo mixes 1/60 and 1/30 → short fraction ~0.5–0.7; normal 30fps is ~0.
    slowAt.push(frac >= 0.35 || stretch > 1);
  }

  // If the whole file looks like slo-mo, one region.
  const slowCount = slowAt.filter(Boolean).length;
  if (stretch > 1 && slowCount >= dts.length * 0.7) {
    return [
      {
        startFrame: 0,
        endFrame: times.length - 1,
        startTime: times[0]!,
        endTime: times[times.length - 1]!,
      },
    ];
  }

  const regions: TimeRegion[] = [];
  let i = 0;
  while (i < slowAt.length) {
    if (!slowAt[i]) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < slowAt.length && slowAt[i]) i += 1;
    const end = i; // exclusive in dts index → frame end = end
    if (end - start < 30) continue;
    regions.push({
      startFrame: start,
      endFrame: Math.min(times.length - 1, end),
      startTime: times[start]!,
      endTime: times[Math.min(times.length - 1, end)]!,
    });
  }
  return regions;
}

/** True when the jump's contact/flight window sits inside a slowed region. */
export function jumpInSlowedSection(
  events: DetectedEvents,
  regions: readonly TimeRegion[],
): boolean {
  if (regions.length === 0) return false;
  const mid = (events.touchdown + events.landing) / 2;
  return regions.some((r) => mid >= r.startFrame && mid <= r.endFrame);
}

export function buildMultiJumpRows(
  jumps: readonly DetectedEvents[],
  frameTimes: readonly number[] | undefined,
  fps: number,
  stretch: number,
  hint: SloMoHint = {},
): MultiJumpRow[] {
  const regions = frameTimes ? slowedRegions(frameTimes, hint) : [];
  return jumps.map((events, index) => {
    const preview = previewMetrics({
      touchdown: events.touchdown,
      takeoff: events.takeoff,
      landing: events.landing,
      fps,
      slowMoFactor: stretch,
      frameTimes,
    });
    const outsideSlow = frameTimes ? !jumpInSlowedSection(events, regions) : false;
    return {
      index,
      events,
      include: true,
      outsideSlow,
      gctMs: preview.gctMs,
      flightMs: preview.flightMs,
      heightIn: preview.heightIn,
      rsi: preview.rsi,
    };
  });
}

export function summarizeSet(rows: readonly MultiJumpRow[]): SetSummary {
  const included = rows.filter((row) => row.include && row.heightIn !== null && row.gctMs !== null && row.rsi !== null);
  if (included.length === 0) {
    return {
      count: 0,
      meanHeightIn: null,
      bestHeightIn: null,
      meanGctMs: null,
      bestGctMs: null,
      meanRsi: null,
      bestRsi: null,
    };
  }
  const heights = included.map((r) => r.heightIn!);
  const gcts = included.map((r) => r.gctMs!);
  const rsis = included.map((r) => r.rsi!);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    count: included.length,
    meanHeightIn: mean(heights),
    bestHeightIn: Math.max(...heights),
    meanGctMs: mean(gcts),
    bestGctMs: Math.min(...gcts),
    meanRsi: mean(rsis),
    bestRsi: Math.max(...rsis),
  };
}

/** Coarse step for long clips: keep single-jump short clips at full rate. */
export function scanStep(frameCount: number): number {
  if (frameCount > 1800) return 6;
  if (frameCount > 900) return 4;
  if (frameCount > 400) return 2;
  return 1;
}
