import { groundModel, type FootSample, type GroundModel } from "./detect.ts";
import { realSecondsOnClock } from "./metrics.ts";

export interface PenultimateMarks {
  touchdown: number;
  takeoff: number;
  /** Which foot produced the penultimate contact. */
  foot: "L" | "R" | "C";
}

export interface ApproachExtraMetrics {
  penultimateGctMs: number | null;
  stepGapMs: number | null;
}

export interface FootContactEvent {
  foot: "L" | "R" | "C";
  touchdown: number;
  takeoff: number;
  contactMs: number | null;
}

export interface ApproachTiming {
  fps: number;
  stretch?: number;
  frameTimes?: readonly number[];
}

/** Hard gates: shorter than this → treat as not found (foot chatter). */
export const MIN_PEN_CONTACT_MS = 80;
export const MIN_STEP_GAP_MS = 60;
/** Soft Check-marks bands (shown when marks exist but look off). */
export const PEN_CONTACT_SOFT_MIN_MS = 80;
export const PEN_CONTACT_SOFT_MAX_MS = 300;
export const STEP_GAP_SOFT_MIN_MS = 60;
export const STEP_GAP_SOFT_MAX_MS = 400;

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

function onGroundY(y: number | undefined, model: GroundModel): boolean {
  return y !== undefined && Number.isFinite(y) && y >= model.ground - model.tolerance;
}

/** Contact streaks for one foot series before `beforeFrame`. */
function contactStreaksBefore(
  frames: readonly number[],
  onGround: readonly boolean[],
  beforeFrame: number,
): Array<{ tdIdx: number; toIdx: number }> {
  const streaks: Array<{ tdIdx: number; toIdx: number }> = [];
  let i = 0;
  while (i < frames.length) {
    if (frames[i]! >= beforeFrame) break;
    if (!onGround[i]) {
      i += 1;
      continue;
    }
    const tdIdx = i;
    while (i < frames.length && frames[i]! < beforeFrame && onGround[i]) i += 1;
    const toIdx = i - 1;
    if (toIdx >= tdIdx) streaks.push({ tdIdx, toIdx });
  }
  return streaks;
}

/**
 * List per-foot (or combined) contact events before plant — for diagnostics.
 */
export function listFootContactsBeforePlant(
  samples: readonly FootSample[],
  plantTouchdown: number,
  timing?: ApproachTiming,
): FootContactEvent[] {
  if (!(plantTouchdown > 0)) return [];
  const ordered = orderedSamples(samples);
  if (ordered.length < 4) return [];
  const model = groundModel(ordered);
  if (!model) return [];

  const frames = ordered.map((s) => s.frame);
  const out: FootContactEvent[] = [];

  const pushFoot = (foot: "L" | "R" | "C", ys: readonly (number | undefined)[]) => {
    const ground = ys.map((y) => onGroundY(y, model));
    if (!ground.some(Boolean)) return;
    for (const streak of contactStreaksBefore(frames, ground, plantTouchdown)) {
      const td = frames[streak.tdIdx]!;
      const to = frames[streak.toIdx]!;
      if (!(td < to)) continue;
      out.push({
        foot,
        touchdown: td,
        takeoff: to,
        contactMs: realMs(timing, td, to),
      });
    }
  };

  const hasLeft = ordered.some((s) => s.leftFootY !== undefined);
  const hasRight = ordered.some((s) => s.rightFootY !== undefined);
  if (hasLeft || hasRight) {
    if (hasLeft) pushFoot(
      "L",
      ordered.map((s) => s.leftFootY),
    );
    if (hasRight) pushFoot(
      "R",
      ordered.map((s) => s.rightFootY),
    );
  } else {
    pushFoot(
      "C",
      ordered.map((s) => s.footY),
    );
  }

  return out.sort((a, b) => a.takeoff - b.takeoff || a.touchdown - b.touchdown);
}

/**
 * Find the contact cycle immediately before plant touchdown.
 * Prefers a single foot (opposite the plant side when separable).
 * Returns null when chatter / wrong-foot / duration gates fail — caller must not invent numbers.
 */
export function detectPenultimate(
  samples: readonly FootSample[],
  plantTouchdown: number,
  timing?: ApproachTiming,
): PenultimateMarks | null {
  if (!(plantTouchdown > 0)) return null;
  const ordered = orderedSamples(samples);
  if (ordered.length < 8) return null;
  const model = groundModel(ordered);
  if (!model) return null;

  const events = listFootContactsBeforePlant(samples, plantTouchdown, timing);
  if (!events.length) return null;

  // Plant-side feet at plant TD (±1 sample).
  let plantIdx = ordered.findIndex((s) => s.frame >= plantTouchdown);
  if (plantIdx < 0) plantIdx = ordered.length - 1;
  const plantSample = ordered[plantIdx]!;
  const plantLeft = onGroundY(plantSample.leftFootY, model);
  const plantRight = onGroundY(plantSample.rightFootY, model);
  const plantFeet = new Set<"L" | "R" | "C">();
  if (plantLeft) plantFeet.add("L");
  if (plantRight) plantFeet.add("R");
  if (!plantFeet.size) plantFeet.add("C");

  // Candidates: end before plant, pass hard duration gates, prefer opposite foot.
  type Ranked = PenultimateMarks & { contactMs: number; gapMs: number; score: number };
  const ranked: Ranked[] = [];
  for (const ev of events) {
    if (!(ev.takeoff < plantTouchdown && ev.touchdown < ev.takeoff)) continue;
    const contactMs = ev.contactMs ?? realMs(timing, ev.touchdown, ev.takeoff);
    const gapMs = realMs(timing, ev.takeoff, plantTouchdown);
    if (contactMs === null || gapMs === null) continue;
    // Hard gates — foot chatter / wrong-foot blinks.
    if (contactMs < MIN_PEN_CONTACT_MS || gapMs < MIN_STEP_GAP_MS) continue;
    // Need a few frames of contact, not 1–2 sample spikes.
    if (ev.takeoff - ev.touchdown < 3) continue;

    let score = contactMs + gapMs * 0.5;
    // Prefer the foot that is not the only plant foot (penultimate ≠ plant).
    if (ev.foot !== "C" && plantFeet.size === 1 && !plantFeet.has(ev.foot)) score += 200;
    if (ev.foot !== "C" && plantFeet.size === 2) score += 80; // bilateral plant — either single foot ok
    // Prefer the last contact before plant (closest takeoff).
    score += ev.takeoff * 0.01;
    ranked.push({
      touchdown: ev.touchdown,
      takeoff: ev.takeoff,
      foot: ev.foot,
      contactMs,
      gapMs,
      score,
    });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score || b.takeoff - a.takeoff);
  const best = ranked[0]!;
  return { touchdown: best.touchdown, takeoff: best.takeoff, foot: best.foot };
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

export function penultimateContactOutOfBand(ms: number | null): boolean {
  if (ms === null || !Number.isFinite(ms)) return false;
  return ms < PEN_CONTACT_SOFT_MIN_MS || ms > PEN_CONTACT_SOFT_MAX_MS;
}

export function stepGapOutOfBand(ms: number | null): boolean {
  if (ms === null || !Number.isFinite(ms)) return false;
  return ms < STEP_GAP_SOFT_MIN_MS || ms > STEP_GAP_SOFT_MAX_MS;
}

/**
 * Soft Check-marks notes for approach extras + plant vs largest flight in clip.
 * Does not invent marks — only flags what is already set.
 */
export function approachPlausibilityWarnings(input: {
  penultimateGctMs: number | null;
  stepGapMs: number | null;
  plantFlightMs: number | null;
  /** Largest real flight among clip candidates (ms), when known. */
  largestFlightMs?: number | null;
  penultimateFound: boolean;
}): string[] {
  const warnings: string[] = [];
  if (!input.penultimateFound) {
    warnings.push(
      "Check marks: penultimate step not found — mark penultimate TD/TO manually if visible.",
    );
    return warnings;
  }
  if (penultimateContactOutOfBand(input.penultimateGctMs)) {
    warnings.push(
      `Check marks: penultimate contact ${input.penultimateGctMs!.toFixed(0)} ms outside 80–300 ms.`,
    );
  }
  if (stepGapOutOfBand(input.stepGapMs)) {
    warnings.push(
      `Check marks: step gap ${input.stepGapMs!.toFixed(0)} ms outside 60–400 ms.`,
    );
  }
  if (
    input.plantFlightMs != null &&
    input.largestFlightMs != null &&
    input.largestFlightMs > 0 &&
    input.plantFlightMs < input.largestFlightMs * 0.85
  ) {
    warnings.push(
      `Check marks: plant flight ${input.plantFlightMs.toFixed(0)} ms < 85% of largest clip flight ${input.largestFlightMs.toFixed(0)} ms — verify plant/TO/LD.`,
    );
  }
  return warnings;
}

/** Format per-foot contacts for the diagnostics panel. */
export function formatFootContactNotes(events: readonly FootContactEvent[]): string[] {
  if (!events.length) return ["Per-foot contacts before plant: none"];
  const lines = ["Per-foot contacts before plant:"];
  for (const ev of events.slice(-12)) {
    const ms = ev.contactMs === null ? "?" : `${ev.contactMs.toFixed(0)} ms`;
    lines.push(`  ${ev.foot} TD${ev.touchdown} TO${ev.takeoff} (${ms})`);
  }
  return lines;
}
