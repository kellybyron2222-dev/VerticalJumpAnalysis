import { groundModel, type FootSample } from "./detect.ts";
import { realSecondsOnClock } from "./metrics.ts";

export interface PenultimateMarks {
  touchdown: number;
  takeoff: number;
}

export interface ApproachExtraMetrics {
  penultimateGctMs: number | null;
  stepGapMs: number | null;
}

function orderedSamples(samples: readonly FootSample[]): FootSample[] {
  const byFrame = new Map<number, FootSample>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.frame) || !Number.isFinite(sample.footY)) continue;
    byFrame.set(Math.round(sample.frame), sample);
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Find the contact cycle immediately before plant touchdown:
 * penultimate touchdown → penultimate toe-off, then flight into plant.
 * Returns null when not clearly visible (caller leaves marks blank).
 */
export function detectPenultimate(
  samples: readonly FootSample[],
  plantTouchdown: number,
): PenultimateMarks | null {
  if (!(plantTouchdown > 0)) return null;
  const ordered = orderedSamples(samples);
  if (ordered.length < 8) return null;
  const model = groundModel(ordered);
  if (!model) return null;

  const onGround = ordered.map((s) => s.footY >= model.ground - model.tolerance);
  let plantIdx = ordered.findIndex((s) => s.frame >= plantTouchdown);
  if (plantIdx < 0) plantIdx = ordered.length - 1;

  // Walk back through the flight into plant, then the prior contact streak.
  let i = plantIdx - 1;
  while (i >= 0 && onGround[i]) i -= 1;
  while (i >= 0 && !onGround[i]) i -= 1;
  if (i < 0) return null;
  const toIdx = i;
  while (i >= 0 && onGround[i]) i -= 1;
  const tdIdx = i + 1;
  if (tdIdx < 0 || tdIdx > toIdx) return null;
  if (toIdx - tdIdx < 2) return null; // need a real contact, not 1–2 frames

  const touchdown = ordered[tdIdx]!.frame;
  const takeoff = ordered[toIdx]!.frame;
  if (!(touchdown < takeoff && takeoff < plantTouchdown)) return null;
  return { touchdown, takeoff };
}

/** Penultimate contact and step gap (pen TO → plant TD), real time. */
export function approachExtraMetrics(input: {
  plantTouchdown: number;
  penultimateTouchdown: number | null;
  penultimateTakeoff: number | null;
  fps: number;
  stretch?: number;
  frameTimes?: readonly number[];
}): ApproachExtraMetrics {
  const stretch = input.stretch ?? 1;
  let penultimateGctMs: number | null = null;
  let stepGapMs: number | null = null;
  if (
    input.penultimateTouchdown !== null &&
    input.penultimateTakeoff !== null &&
    input.penultimateTouchdown < input.penultimateTakeoff
  ) {
    const s = realSecondsOnClock(
      input.frameTimes,
      input.penultimateTouchdown,
      input.penultimateTakeoff,
      input.fps,
      stretch,
    );
    if (s > 0) penultimateGctMs = s * 1000;
  }
  if (
    input.penultimateTakeoff !== null &&
    input.penultimateTakeoff < input.plantTouchdown
  ) {
    const s = realSecondsOnClock(
      input.frameTimes,
      input.penultimateTakeoff,
      input.plantTouchdown,
      input.fps,
      stretch,
    );
    if (s >= 0) stepGapMs = s * 1000;
  }
  return { penultimateGctMs, stepGapMs };
}

/** Plant contact outside ~120–400 ms → Check marks. */
export function plantContactOutOfBand(gctMs: number | null): boolean {
  if (gctMs === null || !Number.isFinite(gctMs)) return false;
  return gctMs < 120 || gctMs > 400;
}
