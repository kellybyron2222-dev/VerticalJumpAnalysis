/**
 * Label-agnostic approach (penultimate / one-step) plant + penultimate marks.
 * MediaPipe swaps L/R at trail-foot join — never trust foot identity for plant TD/TO/LD.
 * Plant TD = first any-foot ground of the final plant; TO = last any-foot ground;
 * landing = first any-foot ground after flight.
 */
import { groundModel, type FootSample, type GroundModel } from "./detect.ts";
import { realSecondsOnClock } from "./metrics.ts";

export interface ApproachTiming {
  fps: number;
  stretch?: number;
  frameTimes?: readonly number[];
}

export interface ApproachDetectResult {
  touchdown: number;
  takeoff: number;
  landing: number;
  /** Null when the penultimate foot is already down as the athlete enters frame. */
  penTouchdown: number | null;
  penTakeoff: number | null;
  /** True when pen TD is not visible (entered mid-contact). */
  penTdBeforeClip: boolean;
  plantContactMs: number | null;
  flightMs: number | null;
  stepGapMs: number | null;
  reason: string;
}

function orderedSamples(samples: readonly FootSample[]): FootSample[] {
  const byFrame = new Map<number, FootSample>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.frame) || !Number.isFinite(sample.footY)) continue;
    byFrame.set(Math.round(sample.frame), sample);
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function realMs(
  timing: ApproachTiming | undefined,
  start: number,
  end: number,
): number | null {
  if (!timing || !(timing.fps > 0) || !(end > start)) return null;
  const s = realSecondsOnClock(
    timing.frameTimes,
    start,
    end,
    timing.fps,
    timing.stretch ?? 1,
  );
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

function footYs(s: FootSample): number[] {
  return [
    s.footY,
    s.heelY,
    s.leftFootY,
    s.rightFootY,
    s.leftHeelY,
    s.rightHeelY,
  ].filter((y): y is number => y !== undefined && Number.isFinite(y));
}

/** Strict any-foot ground — keeps step-gap air from merging into plant. */
function buildStrictGround(ordered: readonly FootSample[], model: GroundModel): boolean[] {
  const floor = model.ground;
  const tol = model.tolerance;
  return ordered.map((s) => footYs(s).some((y) => y >= floor - tol));
}

/**
 * Loose any-foot ground — picks up a single lead heel before the trail joins.
 * Only used when walking plant TD back from a firm takeoff.
 */
function buildLooseGround(ordered: readonly FootSample[], model: GroundModel): boolean[] {
  const floor = model.ground - 0.015;
  const tol = Math.max(model.tolerance, 0.04);
  return ordered.map((s) => footYs(s).some((y) => y >= floor - tol));
}

/** Fill brief pose holes (not large enough to bridge a real step gap ~150+ ms). */
function fillHoles(frames: readonly number[], on: readonly boolean[], maxHole = 4): boolean[] {
  const out = [...on];
  let lastOn = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (!out[i]) continue;
    if (lastOn >= 0) {
      const hole = frames[i]! - frames[lastOn]!;
      if (hole > 1 && hole <= maxHole + 1) {
        for (let k = lastOn + 1; k < i; k += 1) out[k] = true;
      }
    }
    lastOn = i;
  }
  return out;
}

interface Streak {
  tdIdx: number;
  toIdx: number;
}

function groundStreaks(frames: readonly number[], on: readonly boolean[]): Streak[] {
  const filled = fillHoles(frames, on);
  const out: Streak[] = [];
  let i = 0;
  while (i < frames.length) {
    if (!filled[i]) {
      i += 1;
      continue;
    }
    const tdIdx = i;
    while (i < frames.length && filled[i]) i += 1;
    out.push({ tdIdx, toIdx: i - 1 });
  }
  return out;
}

/**
 * Walk plant TD earlier from takeoff using loose ground, stopping at a real air gap.
 */
function refinePlantTdEarlier(
  frames: readonly number[],
  loose: readonly boolean[],
  toIdx: number,
  notBeforeFrame: number,
): number {
  const filled = fillHoles(frames, loose, 5);
  let i = toIdx;
  while (i > 0 && frames[i]! > notBeforeFrame && filled[i]) i -= 1;
  // i is last air (or boundary); plant starts at i+1 if that sample is down.
  const start = filled[i] ? i : i + 1;
  return frames[Math.min(toIdx, Math.max(0, start))]!;
}

/**
 * Detect approach plant + penultimate from pose using any-foot ground only.
 * Does not use L/R labels. Pen TD is blank when contact starts at clip entry.
 */
export function detectApproachFromPose(
  samples: readonly FootSample[],
  timing: ApproachTiming,
): ApproachDetectResult | null {
  const ordered = orderedSamples(samples);
  if (ordered.length < 12) return null;
  const model = groundModel(ordered);
  if (!model) return null;

  const frames = ordered.map((s) => s.frame);
  const strict = buildStrictGround(ordered, model);
  const loose = buildLooseGround(ordered, model);
  const streaks = groundStreaks(frames, strict);
  if (streaks.length < 1) return null;

  type FlightCand = {
    takeoff: number;
    landing: number;
    plantTd: number;
    plantTo: number;
    flightMs: number;
    plantMs: number;
    streakIdx: number;
    toIdx: number;
  };
  const flights: FlightCand[] = [];
  for (let i = 0; i < streaks.length - 1; i += 1) {
    const plant = streaks[i]!;
    const land = streaks[i + 1]!;
    const takeoff = frames[plant.toIdx]!;
    const landing = frames[land.tdIdx]!;
    const plantTd = frames[plant.tdIdx]!;
    const plantTo = takeoff;
    if (!(landing > takeoff + 2)) continue;
    const flightMs = realMs(timing, takeoff, landing);
    const plantMs = realMs(timing, plantTd, plantTo);
    if (flightMs === null || plantMs === null) continue;
    if (flightMs < 150 || plantMs < 80) continue;
    flights.push({
      takeoff,
      landing,
      plantTd,
      plantTo,
      flightMs,
      plantMs,
      streakIdx: i,
      toIdx: plant.toIdx,
    });
  }
  if (!flights.length) return null;

  // Prefer longest flight, then typical approach plant band (~250–420 ms).
  flights.sort((a, b) => {
    const band = (p: FlightCand) => (p.plantMs >= 250 && p.plantMs <= 420 ? 1 : 0);
    return b.flightMs - a.flightMs || band(b) - band(a) || b.plantMs - a.plantMs;
  });
  let best = flights[0]!;
  const strictPlantTd = best.plantTd;

  // Penultimate vs strict plant start (before loose TD refine).
  let penTouchdown: number | null = null;
  let penTakeoff: number | null = null;
  let penTdBeforeClip = false;
  let penStreakIdx = -1;
  for (let i = 0; i < streaks.length; i += 1) {
    const st = streaks[i]!;
    const to = frames[st.toIdx]!;
    if (!(to < strictPlantTd)) break;
    const gap = realMs(timing, to, strictPlantTd);
    if (gap === null || gap < 60) continue;
    penStreakIdx = i;
    penTakeoff = to;
    penTouchdown = frames[st.tdIdx]!;
  }
  if (penStreakIdx === 0) {
    penTdBeforeClip = true;
    penTouchdown = null;
  } else if (penStreakIdx < 0) {
    penTdBeforeClip = true;
    penTouchdown = null;
    penTakeoff = null;
  } else if (penTouchdown !== null) {
    const firstPersonIdx = ordered.findIndex((s) => Number.isFinite(s.footY));
    const entryFrame = firstPersonIdx >= 0 ? frames[firstPersonIdx]! : frames[0]!;
    if (penTouchdown <= entryFrame + 5) {
      penTdBeforeClip = true;
      penTouchdown = null;
    }
  }

  // Refine plant TD earlier with loose ground, but not into the penultimate streak.
  const notBefore = penTakeoff !== null ? penTakeoff + 2 : frames[0]!;
  const refinedTd = refinePlantTdEarlier(frames, loose, best.toIdx, notBefore);
  if (refinedTd < best.plantTd && refinedTd < best.takeoff) {
    const plantMs = realMs(timing, refinedTd, best.takeoff);
    if (plantMs !== null && plantMs >= 80) {
      best = { ...best, plantTd: refinedTd, plantMs };
    }
  }

  const stepGapMs =
    penTakeoff !== null ? realMs(timing, penTakeoff, best.plantTd) : null;

  const reason = penTdBeforeClip
    ? `approach any-foot plant TD${best.plantTd} TO${best.plantTo} LD${best.landing}; pen TD started before clip` +
      (penTakeoff !== null ? ` (pen TO${penTakeoff})` : "")
    : `approach any-foot plant TD${best.plantTd} TO${best.plantTo} LD${best.landing}` +
      (penTouchdown !== null && penTakeoff !== null
        ? `; pen TD${penTouchdown} TO${penTakeoff}`
        : "");

  return {
    touchdown: best.plantTd,
    takeoff: best.plantTo,
    landing: best.landing,
    penTouchdown,
    penTakeoff,
    penTdBeforeClip,
    plantContactMs: best.plantMs,
    flightMs: best.flightMs,
    stepGapMs,
    reason,
  };
}
