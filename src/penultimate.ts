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

/**
 * Hard rejection floor (foot chatter). Soft Check-marks bands stay stricter.
 * Below hard floor → still return best candidate as lowConfidence when possible.
 */
export const MIN_PEN_CONTACT_MS = 50;
export const MIN_STEP_GAP_MS = 30;
/** Soft Check-marks bands (shown when marks exist but look off). */
export const PEN_CONTACT_SOFT_MIN_MS = 80;
export const PEN_CONTACT_SOFT_MAX_MS = 300;
export const STEP_GAP_SOFT_MIN_MS = 60;
export const STEP_GAP_SOFT_MAX_MS = 400;

export interface PenultimateDetectResult {
  marks: PenultimateMarks | null;
  lowConfidence: boolean;
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

function onGroundY(y: number | undefined, model: GroundModel): boolean {
  return y !== undefined && Number.isFinite(y) && y >= model.ground - model.tolerance;
}

/** Heel-OR-toe: either landmark near ground counts as contact. */
function footOnGround(
  heelOrToeY: number | undefined,
  altY: number | undefined,
  model: GroundModel,
): boolean {
  return onGroundY(heelOrToeY, model) || onGroundY(altY, model);
}

/**
 * Per-foot ground from that foot's own Y distribution. Combined-foot ground is often
 * a few cm below a single heel, so L/R series miss real contacts on device pose.
 */
function groundForFootSeries(
  ys: readonly (number | undefined)[],
  fallback: GroundModel,
): GroundModel {
  const vals = ys.filter((y): y is number => y !== undefined && Number.isFinite(y));
  if (vals.length < 6) {
    return { ...fallback, tolerance: Math.max(fallback.tolerance, 0.045) };
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const ground = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
  const tolerance = Math.max(fallback.tolerance, 0.035);
  // Never require a foot to reach deeper than the combined floor.
  return {
    ground: Math.max(ground, fallback.ground - 0.03),
    start: fallback.start,
    tolerance,
  };
}

/** Fill brief air holes so pose dropouts don't split one step into chatter. */
function fillGroundHoles(
  frames: readonly number[],
  onGround: readonly boolean[],
  maxHoleFrames = 4,
): boolean[] {
  const out = [...onGround];
  let lastOn = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (!out[i]) continue;
    if (lastOn >= 0) {
      const hole = frames[i]! - frames[lastOn]!;
      if (hole > 1 && hole <= maxHoleFrames + 1) {
        for (let k = lastOn + 1; k < i; k += 1) out[k] = true;
      }
    }
    lastOn = i;
  }
  return out;
}

/** Contact streaks for one foot series before `beforeFrame`. */
function contactStreaksBefore(
  frames: readonly number[],
  onGround: readonly boolean[],
  beforeFrame: number,
): Array<{ tdIdx: number; toIdx: number }> {
  const filled = fillGroundHoles(frames, onGround);
  const streaks: Array<{ tdIdx: number; toIdx: number }> = [];
  let i = 0;
  while (i < frames.length) {
    if (frames[i]! >= beforeFrame) break;
    if (!filled[i]) {
      i += 1;
      continue;
    }
    const tdIdx = i;
    while (i < frames.length && frames[i]! < beforeFrame && filled[i]) i += 1;
    const toIdx = i - 1;
    if (toIdx >= tdIdx) streaks.push({ tdIdx, toIdx });
  }
  return streaks;
}

/**
 * List per-foot AND combined contact events before plant — for diagnostics + detect.
 * Always includes combined (C) so device L/R gaps still surface the step.
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

  const pushFoot = (
    foot: "L" | "R" | "C",
    primary: readonly (number | undefined)[],
    secondary: readonly (number | undefined)[],
  ) => {
    const footModel = foot === "C" ? model : groundForFootSeries(primary, model);
    const ground = primary.map((y, i) => footOnGround(y, secondary[i], footModel));
    if (!ground.some(Boolean)) return;
    for (const streak of contactStreaksBefore(frames, ground, plantTouchdown)) {
      const td = frames[streak.tdIdx]!;
      const to = frames[streak.toIdx]!;
      if (!(td <= to)) continue;
      // Single-frame contacts are still listed for diagnostics.
      out.push({
        foot,
        touchdown: td,
        takeoff: to,
        contactMs: td < to ? realMs(timing, td, to) : 0,
      });
    }
  };

  const hasLeft = ordered.some((s) => s.leftFootY !== undefined || s.leftHeelY !== undefined);
  const hasRight = ordered.some((s) => s.rightFootY !== undefined || s.rightHeelY !== undefined);
  if (hasLeft) {
    pushFoot(
      "L",
      ordered.map((s) => s.leftHeelY ?? s.leftFootY),
      ordered.map((s) => s.leftFootY ?? s.leftHeelY),
    );
  }
  if (hasRight) {
    pushFoot(
      "R",
      ordered.map((s) => s.rightHeelY ?? s.rightFootY),
      ordered.map((s) => s.rightFootY ?? s.rightHeelY),
    );
  }
  // Always include combined — phone L/R landmarks are often incomplete before plant.
  pushFoot(
    "C",
    ordered.map((s) => s.heelY ?? s.footY),
    ordered.map((s) => s.footY),
  );

  return out.sort((a, b) => a.takeoff - b.takeoff || a.touchdown - b.touchdown);
}

/**
 * Find the contact cycle immediately before plant touchdown.
 * Either foot allowed; heel-OR-toe ground. Hard floor 50/30 ms — below that
 * still returns the best candidate as lowConfidence so Byron can review.
 */
export function detectPenultimateDetailed(
  samples: readonly FootSample[],
  plantTouchdown: number,
  timing?: ApproachTiming,
): PenultimateDetectResult {
  if (!(plantTouchdown > 0)) {
    return { marks: null, lowConfidence: true, reason: "no plant touchdown" };
  }
  const ordered = orderedSamples(samples);
  if (ordered.length < 8) {
    return { marks: null, lowConfidence: true, reason: "too few samples" };
  }
  const model = groundModel(ordered);
  if (!model) {
    return { marks: null, lowConfidence: true, reason: "no ground model" };
  }

  const events = listFootContactsBeforePlant(samples, plantTouchdown, timing);
  if (!events.length) {
    return {
      marks: null,
      lowConfidence: true,
      reason: `no per-foot contacts before plant (samples ${ordered.length})`,
    };
  }

  let plantIdx = ordered.findIndex((s) => s.frame >= plantTouchdown);
  if (plantIdx < 0) plantIdx = ordered.length - 1;
  const plantSample = ordered[plantIdx]!;
  const plantLeft = footOnGround(plantSample.leftHeelY, plantSample.leftFootY, model);
  const plantRight = footOnGround(plantSample.rightHeelY, plantSample.rightFootY, model);
  const plantFeet = new Set<"L" | "R" | "C">();
  if (plantLeft) plantFeet.add("L");
  if (plantRight) plantFeet.add("R");
  if (!plantFeet.size) plantFeet.add("C");

  const estimateMs = (start: number, end: number): number | null => {
    const timed = realMs(timing, start, end);
    if (timed !== null) return timed;
    if (timing && timing.fps > 0 && end > start) {
      return ((end - start) / timing.fps / (timing.stretch ?? 1)) * 1000;
    }
    return null;
  };

  type Ranked = PenultimateMarks & {
    contactMs: number;
    gapMs: number;
    score: number;
    hardOk: boolean;
  };
  const ranked: Ranked[] = [];
  for (const ev of events) {
    // Penultimate must end before plant TD (separate step).
    if (!(ev.takeoff < plantTouchdown && ev.touchdown <= ev.takeoff)) continue;
    const contactMs =
      ev.touchdown < ev.takeoff
        ? (ev.contactMs ?? estimateMs(ev.touchdown, ev.takeoff))
        : 0;
    const gapMs = estimateMs(ev.takeoff, plantTouchdown);
    if (contactMs === null || gapMs === null) continue;
    // Ignore tiny pose blinks (allow 1-frame listed contacts only in diagnostics).
    if (ev.takeoff - ev.touchdown < 1) continue;

    const hardOk = contactMs >= MIN_PEN_CONTACT_MS && gapMs >= MIN_STEP_GAP_MS;
    let score = contactMs + gapMs * 0.35;
    // Prefer the last step before plant (closest takeoff).
    score += ev.takeoff * 0.05;
    // Prefer a clear airborne gap into plant.
    if (gapMs >= MIN_STEP_GAP_MS) score += 80;
    // Either foot ok; slight preference for opposite of sole plant foot.
    if (ev.foot !== "C" && plantFeet.size === 1 && !plantFeet.has(ev.foot)) score += 120;
    if (ev.foot !== "C" && plantFeet.size === 2) score += 40;
    // Prefer L/R over combined when both exist.
    if (ev.foot !== "C") score += 30;
    if (hardOk) score += 500;
    ranked.push({
      touchdown: ev.touchdown,
      takeoff: ev.takeoff,
      foot: ev.foot,
      contactMs,
      gapMs,
      score,
      hardOk,
    });
  }
  if (!ranked.length) {
    return {
      marks: null,
      lowConfidence: true,
      reason: `no ranked penultimate candidate (${events.length} contacts listed)`,
    };
  }
  ranked.sort((a, b) => b.score - a.score || b.takeoff - a.takeoff);
  const best = ranked[0]!;
  const marks = { touchdown: best.touchdown, takeoff: best.takeoff, foot: best.foot };
  if (best.hardOk) {
    return {
      marks,
      lowConfidence: false,
      reason: `penultimate ${best.foot} TD${best.touchdown} TO${best.takeoff}`,
    };
  }
  return {
    marks,
    lowConfidence: true,
    reason:
      `low-confidence penultimate ${best.foot} TD${best.touchdown} TO${best.takeoff}` +
      ` (contact ${best.contactMs.toFixed(0)} ms, gap ${best.gapMs.toFixed(0)} ms) — verify marks`,
  };
}

/** Convenience wrapper — marks only (null when nothing plausible). */
export function detectPenultimate(
  samples: readonly FootSample[],
  plantTouchdown: number,
  timing?: ApproachTiming,
): PenultimateMarks | null {
  return detectPenultimateDetailed(samples, plantTouchdown, timing).marks;
}

/** Never accept a refined plant contact shorter than this (real ms). */
export const MIN_PLANT_CONTACT_MS = 80;

/**
 * Plant TD = first ground contact of the final plant step before takeoff.
 * Prefer the plant foot's first hit (later of L/R streak starts) over an earlier
 * other-foot contact — but never allow plant contact &lt; 80 ms; if the refine
 * would, keep the unrefined TD.
 */
export function refineApproachPlantTouchdown(
  samples: readonly FootSample[],
  takeoff: number,
  proposedTd: number,
  timing?: ApproachTiming,
): { touchdown: number; reason: string } {
  const ordered = orderedSamples(samples);
  if (ordered.length < 4 || !(takeoff > 0)) {
    return { touchdown: proposedTd, reason: "plant TD unchanged (insufficient samples)" };
  }
  const model = groundModel(ordered);
  if (!model) {
    return { touchdown: proposedTd, reason: "plant TD unchanged (no ground model)" };
  }

  let toIdx = ordered.findIndex((s) => s.frame >= takeoff);
  if (toIdx < 0) toIdx = ordered.length - 1;

  const downAt = (
    s: (typeof ordered)[number],
    foot: "L" | "R" | "C",
  ): boolean => {
    if (foot === "L") return footOnGround(s.leftHeelY, s.leftFootY, model);
    if (foot === "R") return footOnGround(s.rightHeelY, s.rightFootY, model);
    return (
      footOnGround(s.heelY, s.footY, model) ||
      footOnGround(s.leftHeelY, s.leftFootY, model) ||
      footOnGround(s.rightHeelY, s.rightFootY, model)
    );
  };

  /**
   * Start frame of the contact streak of `foot` that is still down in the last
   * few frames before takeoff (final plant step). Earlier steps that already
   * left the ground are ignored.
   */
  const streakStart = (foot: "L" | "R" | "C"): number | null => {
    // Foot must be on ground near takeoff to count as the plant step.
    let near = -1;
    for (let j = toIdx - 1; j >= Math.max(0, toIdx - 4); j -= 1) {
      if (downAt(ordered[j]!, foot)) {
        near = j;
        break;
      }
    }
    if (near < 0) return null;
    let i = near;
    while (i >= 0 && downAt(ordered[i]!, foot)) i -= 1;
    return ordered[i + 1]!.frame;
  };

  const contactMsOf = (td: number): number | null => {
    const timed = realMs(timing, td, takeoff);
    if (timed !== null) return timed;
    // No clock: approximate with capture fps if provided, else reject near-TO blinks.
    if (timing && timing.fps > 0) {
      return ((takeoff - td) / timing.fps / (timing.stretch ?? 1)) * 1000;
    }
    return null;
  };

  const hasLR = ordered.some(
    (s) =>
      s.leftFootY !== undefined ||
      s.leftHeelY !== undefined ||
      s.rightFootY !== undefined ||
      s.rightHeelY !== undefined,
  );

  const accept = (
    foot: "L" | "R" | "C",
    start: number | null,
  ): { start: number; ms: number; foot: "L" | "R" | "C" } | null => {
    if (start === null || !(start < takeoff)) return null;
    const ms = contactMsOf(start);
    if (ms === null) {
      if (takeoff - start >= 8) return { start, ms: takeoff - start, foot };
      return null;
    }
    if (ms >= MIN_PLANT_CONTACT_MS) return { start, ms, foot };
    return null;
  };

  // Candidates with ≥80 ms contact. Prefer later first-hit (plant foot vs earlier
  // other-foot), then longer contact. Near-TO blinks never enter this list.
  const cands: Array<{ start: number; ms: number; foot: "L" | "R" | "C" }> = [];
  if (hasLR) {
    const l = accept("L", streakStart("L"));
    const r = accept("R", streakStart("R"));
    if (l) cands.push(l);
    if (r) cands.push(r);
  }
  if (!cands.length) {
    const c = accept("C", streakStart("C"));
    if (c) cands.push(c);
  }
  // Prefer longer valid plant contact (not a late short join), then earlier start.
  cands.sort((a, b) => b.ms - a.ms || a.start - b.start);
  const chosen = cands[0] ?? null;
  const usedFoot = chosen?.foot ?? "C";

  if (!chosen) {
    return {
      touchdown: proposedTd,
      reason:
        `plant TD refine rejected (no ≥${MIN_PLANT_CONTACT_MS} ms contact before TO${takeoff});` +
        ` kept TD${proposedTd}`,
    };
  }

  const refined = chosen.start;
  if (refined === proposedTd) {
    return {
      touchdown: proposedTd,
      reason: `plant TD${proposedTd} = ${usedFoot} first hit before TO${takeoff} (${chosen.ms.toFixed(0)} ms)`,
    };
  }
  return {
    touchdown: refined,
    reason:
      `plant TD refined ${proposedTd}→${refined} (${usedFoot} first hit of final plant step before TO${takeoff},` +
      ` ${chosen.ms.toFixed(0)} ms; not earlier other-foot contact)`,
  };
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
export function formatFootContactNotes(
  events: readonly FootContactEvent[],
  sampleCount?: number,
): string[] {
  const head =
    sampleCount !== undefined
      ? `Per-foot contacts before plant (${events.length} events, ${sampleCount} pose samples):`
      : `Per-foot contacts before plant (${events.length} events):`;
  if (!events.length) return [`${head} none`];
  const lines = [head];
  // Show the last contacts (closest to plant) — most relevant for penultimate.
  for (const ev of events.slice(-16)) {
    const ms = ev.contactMs === null ? "?" : `${ev.contactMs.toFixed(0)} ms`;
    lines.push(`  ${ev.foot} TD${ev.touchdown} TO${ev.takeoff} (${ms})`);
  }
  return lines;
}
