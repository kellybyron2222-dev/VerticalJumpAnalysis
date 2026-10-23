import {
  emptyDiagnostics,
  eventsFromCandidate,
  scoreJumpCycle,
  type DetectCandidate,
  type DetectDiagnostics,
} from "./detectDiag.ts";
import { realSecondsOnClock } from "./metrics.ts";

/**
 * One pose sample. `footY` is the contact signal in normalized image
 * coordinates (0 = top, 1 = bottom): lowest visible foot/ankle/heel, or a
 * hip/knee proxy when feet are not confident (dark shoes on dark floor).
 */
export interface FootSample {
  frame: number;
  footY: number;
  /** Lowest point of the higher foot, when both feet are visible. The trailing foot leaves the box last. */
  upperFootY?: number;
  /** Mid-hip Y when available (larger = lower in frame). */
  hipY?: number;
}

/** Timing for real-time foot velocity (presentation clock ÷ stretch). */
export interface FootSpeedTiming {
  captureFps: number;
  stretch: number;
  frameTimes?: readonly number[];
}

export interface GroundModel {
  /** Foot height while standing on the floor. */
  ground: number;
  /** Foot height at the start of the clip (standing on the box). */
  start: number;
  /** Samples within this distance of `ground` count as contact. */
  tolerance: number;
}

export interface DetectedEvents {
  /** Last frame with both feet on the box, or null when no box level is visible. */
  stepOff: number | null;
  touchdown: number;
  takeoff: number;
  landing: number;
}

export type Detection =
  | {
      ok: true;
      events: DetectedEvents;
      model: GroundModel;
      diagnostics: DetectDiagnostics;
      lowConfidence?: boolean;
    }
  | { ok: false; reason: string; diagnostics: DetectDiagnostics };

const MIN_SAMPLES = 5;
/** Loose default so short GCT / coarse scans still find takeoff. */
const DEFAULT_MIN_AIR = 3;

/** Foot Y units per real second — near-zero after a strike. */
const FOOT_STILL_V = 0.28;
/** Upward (negative dy/dt) threshold to mark takeoff. */
const FOOT_TAKEOFF_V = 0.45;
/** Prior downward peak to trust a stop as touchdown/landing. */
const FOOT_DOWN_PEAK_V = 0.35;
const FOOT_STILL_HOLD_S = 0.035;
const FOOT_SMOOTH = 5;

function sortedSamples(samples: readonly FootSample[]): FootSample[] {
  const byFrame = new Map<number, FootSample>();
  for (const sample of samples) {
    if (Number.isFinite(sample.frame) && Number.isFinite(sample.footY)) {
      const frame = Math.round(sample.frame);
      const prev = byFrame.get(frame);
      byFrame.set(frame, {
        frame,
        footY: sample.footY,
        upperFootY:
          sample.upperFootY !== undefined && Number.isFinite(sample.upperFootY)
            ? sample.upperFootY
            : prev?.upperFootY,
        hipY: sample.hipY !== undefined && Number.isFinite(sample.hipY) ? sample.hipY : prev?.hipY,
      });
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function findStepOff(ordered: readonly FootSample[], tdIndex: number, ground: number): number | null {
  const level = (sample: FootSample) => sample.upperFootY ?? sample.footY;
  const head = ordered.slice(0, Math.max(3, Math.floor(ordered.length * 0.1))).map(level);
  const box = quantile(head, 0.5);
  const drop = ground - box;
  if (drop < 0.015) return null;
  const tolerance = Math.min(0.012, Math.max(0.003, drop * 0.04));
  for (let k = tdIndex - 1; k >= 0; k -= 1) {
    if (level(ordered[k]!) <= box + tolerance) return ordered[k]!.frame;
  }
  return null;
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index]!;
}

export function groundModel(samples: readonly FootSample[]): GroundModel | null {
  const ordered = sortedSamples(samples);
  if (ordered.length < MIN_SAMPLES) return null;
  const ys = ordered.map((sample) => sample.footY);
  const tailStart = Math.floor(ys.length * 0.35);
  const floorSource = ys.length - tailStart >= 6 ? ys.slice(tailStart) : ys;
  const ground = quantile(floorSource, 0.9);
  const head = ys.slice(0, Math.max(3, Math.floor(ys.length * 0.1)));
  const start = quantile(head, 0.5);
  const drop = ground - start;
  const tolerance = Math.min(0.04, Math.max(0.012, Math.abs(drop) * 0.22 || 0.018));
  return { ground, start, tolerance };
}

function contactHelpers(ordered: readonly FootSample[], onGround: readonly boolean[], minAirFrames: number) {
  const nextContact = (from: number): number => {
    let index = from;
    while (index < ordered.length && !onGround[index]) index += 1;
    return index;
  };
  const nextAir = (from: number): number => {
    let index = from;
    while (index < ordered.length) {
      while (index < ordered.length && onGround[index]) index += 1;
      if (index >= ordered.length) return index;
      const back = nextContact(index);
      const lastAirFrame = back < ordered.length ? ordered[back]!.frame : Infinity;
      if (lastAirFrame - ordered[index]!.frame >= minAirFrames) return index;
      index = back;
    }
    return index;
  };
  return { nextContact, nextAir };
}

function findStepOffInRange(
  ordered: readonly FootSample[],
  tdIndex: number,
  fromIndex: number,
  ground: number,
): number | null {
  const level = (sample: FootSample) => sample.upperFootY ?? sample.footY;
  const window = ordered.slice(Math.max(0, fromIndex), tdIndex);
  if (window.length < 3) return findStepOff(ordered, tdIndex, ground);
  const head = window.slice(0, Math.max(3, Math.floor(window.length * 0.25))).map(level);
  const box = quantile(head, 0.5);
  const drop = ground - box;
  if (drop < 0.015) return null;
  const tolerance = Math.min(0.012, Math.max(0.003, drop * 0.04));
  for (let k = tdIndex - 1; k >= fromIndex; k -= 1) {
    if (level(ordered[k]!) <= box + tolerance) return ordered[k]!.frame;
  }
  return null;
}

function buildOnGround(ordered: readonly FootSample[], model: GroundModel): boolean[] {
  return ordered.map((sample) => sample.footY >= model.ground - model.tolerance);
}

function hipRange(ordered: readonly FootSample[]): { min: number | null; max: number | null } {
  const hips = ordered.map((s) => s.hipY).filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (!hips.length) return { min: null, max: null };
  return { min: Math.min(...hips), max: Math.max(...hips) };
}

function scoreCandidate(
  ordered: readonly FootSample[],
  model: GroundModel,
  tdIndex: number,
  toIndex: number,
  ldIndex: number,
  searchFrom: number,
): DetectCandidate {
  const touchdown = ordered[tdIndex]!.frame;
  const takeoff = ordered[toIndex]!.frame;
  const landing = ordered[ldIndex]!.frame;
  const scored = scoreJumpCycle(touchdown, takeoff, landing);
  const toY = ordered[toIndex]!.footY;
  const fromFloor = toY >= model.ground - model.tolerance * 2 ? 10 : 0;
  let minY = 1;
  let maxY = 0;
  for (let k = toIndex; k <= ldIndex; k += 1) {
    const y = ordered[k]!.footY;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const swingBonus = Math.min(8, (maxY - minY) * 30);
  return {
    stepOff: findStepOffInRange(ordered, tdIndex, searchFrom, model.ground),
    touchdown,
    takeoff,
    landing,
    score: scored.score + fromFloor + swingBonus,
    note: fromFloor ? scored.note : `${scored.note}; takeoff not from floor`,
  };
}

/** Moving-average smooth of footY (image Y; larger = lower in frame). */
export function smoothFootY(values: readonly number[], window = FOOT_SMOOTH): number[] {
  const half = Math.max(1, Math.floor(window / 2));
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - half; k <= i + half; k += 1) {
      if (k < 0 || k >= values.length) continue;
      sum += values[k]!;
      n += 1;
    }
    return n ? sum / n : values[i]!;
  });
}

/**
 * Vertical foot velocity in footY units per *real* second (after stretch).
 * Positive = moving down the image (toward the floor).
 */
export function footVerticalVelocity(
  ordered: readonly FootSample[],
  timing: FootSpeedTiming,
): number[] {
  const ys = smoothFootY(ordered.map((s) => s.footY));
  const vel = new Array<number>(ordered.length).fill(0);
  for (let i = 1; i < ordered.length; i += 1) {
    const dt = realSecondsOnClock(
      timing.frameTimes,
      ordered[i - 1]!.frame,
      ordered[i]!.frame,
      timing.captureFps,
      timing.stretch,
    );
    if (!(dt > 1e-6)) {
      vel[i] = vel[i - 1] ?? 0;
      continue;
    }
    vel[i] = (ys[i]! - ys[i - 1]!) / dt;
  }
  if (vel.length) vel[0] = vel[1] ?? 0;
  return smoothFootY(vel, 3);
}

function indexStillAfterDown(
  vel: readonly number[],
  ordered: readonly FootSample[],
  timing: FootSpeedTiming,
  from: number,
): number | null {
  let peakDown = 0;
  for (let i = from; i < vel.length; i += 1) {
    const v = vel[i]!;
    if (v > peakDown) peakDown = v;
    if (peakDown < FOOT_DOWN_PEAK_V) continue;
    if (Math.abs(v) > FOOT_STILL_V) continue;
    // Hold still for FOOT_STILL_HOLD_S.
    let j = i;
    let held = 0;
    while (j + 1 < vel.length && Math.abs(vel[j + 1]!) <= FOOT_STILL_V * 1.35) {
      held += realSecondsOnClock(
        timing.frameTimes,
        ordered[j]!.frame,
        ordered[j + 1]!.frame,
        timing.captureFps,
        timing.stretch,
      );
      j += 1;
      if (held >= FOOT_STILL_HOLD_S) return i;
    }
  }
  return null;
}

function indexTakeoffUp(vel: readonly number[], from: number): number | null {
  for (let i = from + 1; i < vel.length; i += 1) {
    if (vel[i]! <= -FOOT_TAKEOFF_V) return i;
  }
  return null;
}

/** Reject walk→box plateaus: real flight is mostly moving, not standing still mid-air. */
function flightMostlyMoving(
  vel: readonly number[],
  toIndex: number,
  ldIndex: number,
): boolean {
  let still = 0;
  let n = 0;
  for (let i = toIndex + 1; i < ldIndex; i += 1) {
    n += 1;
    if (Math.abs(vel[i]!) < FOOT_STILL_V) still += 1;
  }
  if (n < 3) return false;
  return still / n < 0.42;
}

/**
 * Foot-speed foot-strike detector: touchdown = downward speed → ~0 after
 * step-off (or mid-drop); takeoff = first upward burst; landing = next stop.
 */
export function detectFootSpeedCycles(
  samples: readonly FootSample[],
  timing: FootSpeedTiming,
  options: { maxJumps?: number; model?: GroundModel | null } = {},
): DetectCandidate[] {
  const maxJumps = options.maxJumps ?? 8;
  const ordered = sortedSamples(samples);
  if (ordered.length < MIN_SAMPLES) return [];
  const vel = footVerticalVelocity(ordered, timing);
  const model = options.model ?? groundModel(ordered);
  const out: DetectCandidate[] = [];
  let search = 0;

  while (out.length < maxJumps && search < ordered.length - 3) {
    const tdIndex = indexStillAfterDown(vel, ordered, timing, search);
    if (tdIndex === null) break;
    const toIndex = indexTakeoffUp(vel, tdIndex);
    if (toIndex === null) break;
    const ldIndex = indexStillAfterDown(vel, ordered, timing, toIndex);
    if (ldIndex === null || ldIndex <= toIndex) {
      search = tdIndex + 1;
      continue;
    }
    if (!flightMostlyMoving(vel, toIndex, ldIndex)) {
      // Likely standing on the box after a step — skip this takeoff, keep searching.
      search = toIndex + 1;
      continue;
    }

    const touchdown = ordered[tdIndex]!.frame;
    const takeoff = ordered[toIndex]!.frame;
    const landing = ordered[ldIndex]!.frame;
    const scored = scoreJumpCycle(touchdown, takeoff, landing);
    if (scored.score < 3) {
      search = tdIndex + 1;
      continue;
    }
    out.push({
      stepOff: model ? findStepOffInRange(ordered, tdIndex, search, model.ground) : null,
      touchdown,
      takeoff,
      landing,
      score: scored.score + 6,
      note: `${scored.note}; foot-speed`,
    });
    search = ldIndex + 1;
  }
  return out;
}

/** Prefer cycles that floor-contact and foot-speed both see (within ±tol frames). */
export function mergeDetectionCandidates(
  floor: readonly DetectCandidate[],
  speed: readonly DetectCandidate[],
  frameTol = 12,
): DetectCandidate[] {
  const merged: DetectCandidate[] = [];
  const usedSpeed = new Set<number>();
  const strongFloor = floor.filter((f) => f.score >= 10);

  for (const f of floor) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < speed.length; i += 1) {
      if (usedSpeed.has(i)) continue;
      const s = speed[i]!;
      const dist =
        Math.abs(s.touchdown - f.touchdown) +
        Math.abs(s.takeoff - f.takeoff) +
        Math.abs(s.landing - f.landing);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestDist <= frameTol * 3) {
      usedSpeed.add(bestIdx);
      // Keep floor marks (repeatable); boost score when foot-speed agrees.
      merged.push({
        ...f,
        score: f.score + 10,
        note: `${f.note ?? "ok"}; agreed with foot-speed`,
      });
    } else {
      merged.push(f);
    }
  }

  // Speed-only fallback when floor is weak, or for clearly later separated cycles.
  const hasStrongFloor = strongFloor.length > 0;
  for (let i = 0; i < speed.length; i += 1) {
    if (usedSpeed.has(i)) continue;
    const s = speed[i]!;
    if (hasStrongFloor) {
      const overlapsStrong = strongFloor.some(
        (f) => s.touchdown <= f.landing + frameTol && f.touchdown <= s.landing + frameTol,
      );
      const beforeAllStrong = strongFloor.every((f) => s.landing < f.touchdown - frameTol);
      // Skip early false strikes (walking) when a confident floor jump exists.
      if (overlapsStrong || beforeAllStrong) continue;
    }
    merged.push(s);
  }
  return merged;
}

/** Enumerate TD/TO/LD cycles, including rebound-centric search after walking lead-ins. */
export function enumerateJumpCycles(
  samples: readonly FootSample[],
  options: {
    fixedModel?: GroundModel;
    minAirFrames?: number;
    maxJumps?: number;
    timing?: FootSpeedTiming;
  } = {},
): { model: GroundModel | null; candidates: DetectCandidate[]; ordered: FootSample[] } {
  const minAirFrames = options.minAirFrames ?? DEFAULT_MIN_AIR;
  const maxJumps = options.maxJumps ?? 12;
  const ordered = sortedSamples(samples);
  const model = options.fixedModel ?? groundModel(ordered);
  if (!model) return { model: null, candidates: [], ordered };

  const onGround = buildOnGround(ordered, model);
  const { nextContact, nextAir } = contactHelpers(ordered, onGround, minAirFrames);
  const candidates: DetectCandidate[] = [];
  const seen = new Set<string>();
  const pushUnique = (cand: DetectCandidate) => {
    const key = `${cand.touchdown}:${cand.takeoff}:${cand.landing}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(cand);
  };

  let i = 0;
  let searchFrom = 0;
  while (candidates.length < maxJumps && i < ordered.length) {
    while (i < ordered.length && onGround[i]) i += 1;
    if (i >= ordered.length) break;

    const tdIndex = nextContact(i);
    if (tdIndex >= ordered.length) break;
    const toIndex = nextAir(tdIndex);
    if (toIndex >= ordered.length) break;
    const ldIndex = nextContact(toIndex);
    if (ldIndex >= ordered.length) break;

    pushUnique(scoreCandidate(ordered, model, tdIndex, toIndex, ldIndex, searchFrom));
    searchFrom = ldIndex;
    // Only skip far ahead for strong floor-takeoff cycles; weak ones may have
    // stolen the real touchdown as "landing".
    const last = candidates[candidates.length - 1]!;
    i = last.score >= 20 && last.note === "ok"
      ? Math.min(ordered.length, ldIndex + 1)
      : Math.min(ordered.length, tdIndex + 1);
  }

  // Rebound-centric pass: takeoff must leave the floor, then landing, then
  // touchdown = start of that contact run (survives walking → box false cycles).
  for (let toIndex = 1; toIndex < ordered.length && candidates.length < maxJumps * 2; toIndex += 1) {
    if (!onGround[toIndex - 1] || onGround[toIndex]) continue;
    const toY = ordered[toIndex]!.footY;
    if (toY < model.ground - model.tolerance * 2) continue; // not leaving the floor
    // Duration of this air must look like a flight.
    const ldIndex = nextContact(toIndex);
    if (ldIndex >= ordered.length) continue;
    if (ordered[ldIndex]!.frame - ordered[toIndex]!.frame < minAirFrames) continue;
    // Contact run immediately before takeoff.
    let tdIndex = toIndex - 1;
    while (tdIndex > 0 && onGround[tdIndex - 1]) tdIndex -= 1;
    if (tdIndex >= toIndex) continue;
    pushUnique(scoreCandidate(ordered, model, tdIndex, toIndex, ldIndex, 0));
  }

  const timing = options.timing ?? { captureFps: 240, stretch: 1 };
  const speed = detectFootSpeedCycles(ordered, timing, { maxJumps, model });
  const merged = mergeDetectionCandidates(candidates, speed);
  return { model, candidates: merged, ordered };
}

/**
 * Classic single-jump detector. Picks the best cycle (not always the first),
 * so a walking/turning lead-in does not steal the real drop jump. Proposes
 * low-confidence marks when the best cycle is marginal instead of refusing.
 */
export function detectEvents(
  samples: readonly FootSample[],
  fixedModel?: GroundModel,
  minAirFrames = DEFAULT_MIN_AIR,
  baseDiag?: Partial<DetectDiagnostics>,
  timing?: FootSpeedTiming,
): Detection {
  const hips = hipRange(sortedSamples(samples));
  const base = emptyDiagnostics({
    ...baseDiag,
    hipYMin: baseDiag?.hipYMin ?? hips.min,
    hipYMax: baseDiag?.hipYMax ?? hips.max,
    framesWithPerson: baseDiag?.framesWithPerson ?? sortedSamples(samples).length,
  });

  const { model, candidates, ordered } = enumerateJumpCycles(samples, {
    fixedModel,
    minAirFrames,
    timing,
  });
  if (!model) {
    return {
      ok: false,
      reason:
        "No plausible jump found. Mark touchdown, takeoff, and landing by hand.",
      diagnostics: { ...base, rejectStage: "no_samples", candidates: [] },
    };
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const diag: DetectDiagnostics = {
    ...base,
    candidates: ranked,
    hipYMin: hips.min,
    hipYMax: hips.max,
    framesWithPerson: ordered.length,
  };

  if (ranked.length === 0) {
    const anyLeave = ordered.some((s) => s.footY < model.ground - model.tolerance);
    return {
      ok: false,
      reason: anyLeave
        ? "No plausible jump found (motion without a clear rebound). Mark events by hand."
        : "No plausible jump found (feet never clearly left the floor). Mark events by hand.",
      diagnostics: {
        ...diag,
        rejectStage: anyLeave ? "no_rebound" : "no_drop",
      },
    };
  }

  const best = ranked[0]!;
  const scored = scoreJumpCycle(best.touchdown, best.takeoff, best.landing);

  if (best.score >= 10) {
    return {
      ok: true,
      model,
      events: eventsFromCandidate(best),
      lowConfidence: false,
      diagnostics: { ...diag, rejectStage: "ok", lowConfidence: false },
    };
  }

  // Marginal but proposable — place marks and flag low confidence.
  if (best.score >= 3) {
    return {
      ok: true,
      model,
      events: eventsFromCandidate(best),
      lowConfidence: true,
      diagnostics: {
        ...diag,
        rejectStage: scored.stage === "ok" ? "contact_out_of_range" : scored.stage,
        lowConfidence: true,
        notes: [...diag.notes, "Low confidence marks — check them.", scored.note],
      },
    };
  }

  return {
    ok: false,
    reason: `No plausible jump found (${scored.note}). Mark touchdown, takeoff, and landing by hand.`,
    diagnostics: { ...diag, rejectStage: scored.stage, lowConfidence: true },
  };
}

export type MultiDetection =
  | {
      ok: true;
      jumps: DetectedEvents[];
      model: GroundModel;
      diagnostics: DetectDiagnostics;
      lowConfidence?: boolean;
    }
  | { ok: false; reason: string; diagnostics: DetectDiagnostics };

/**
 * Find every drop/depth cycle. Splits on standing; used only when 2+ clear jumps.
 */
export function detectAllEvents(
  samples: readonly FootSample[],
  options: {
    fixedModel?: GroundModel;
    minAirFrames?: number;
    minStandFrames?: number;
    maxJumps?: number;
    timing?: FootSpeedTiming;
  } = {},
): MultiDetection {
  const minAirFrames = options.minAirFrames ?? DEFAULT_MIN_AIR;
  const minStandFrames = options.minStandFrames ?? 10;
  const maxJumps = options.maxJumps ?? 8;
  const ordered = sortedSamples(samples);
  const hips = hipRange(ordered);
  const base = emptyDiagnostics({
    framesWithPerson: ordered.length,
    hipYMin: hips.min,
    hipYMax: hips.max,
  });
  const model = options.fixedModel ?? groundModel(ordered);
  if (!model) {
    return {
      ok: false,
      reason: "No plausible jump found. Mark events by hand.",
      diagnostics: { ...base, rejectStage: "no_samples" },
    };
  }

  const onGround = buildOnGround(ordered, model);
  const { nextContact, nextAir } = contactHelpers(ordered, onGround, minAirFrames);
  const floorCandidates: DetectCandidate[] = [];
  let i = 0;
  let searchFrom = 0;

  while (floorCandidates.length < maxJumps && i < ordered.length) {
    while (i < ordered.length && onGround[i]) i += 1;
    if (i >= ordered.length) break;

    const tdIndex = nextContact(i);
    if (tdIndex >= ordered.length) break;
    const toIndex = nextAir(tdIndex);
    if (toIndex >= ordered.length) break;
    const ldIndex = nextContact(toIndex);
    if (ldIndex >= ordered.length) break;

    const touchdown = ordered[tdIndex]!.frame;
    const takeoff = ordered[toIndex]!.frame;
    const landing = ordered[ldIndex]!.frame;
    const scored = scoreJumpCycle(touchdown, takeoff, landing);
    const cand: DetectCandidate = {
      stepOff: findStepOffInRange(ordered, tdIndex, searchFrom, model.ground),
      touchdown,
      takeoff,
      landing,
      score: scored.score,
      note: scored.note,
    };
    floorCandidates.push(cand);

    let stand = 0;
    let j = ldIndex;
    while (j < ordered.length && onGround[j]) {
      stand += 1;
      j += 1;
    }
    searchFrom = ldIndex;
    if (stand < minStandFrames) {
      i = Math.min(ordered.length, ldIndex + 1);
      continue;
    }
    i = ldIndex;
  }

  const timing = options.timing ?? { captureFps: 240, stretch: 1 };
  const speed = detectFootSpeedCycles(ordered, timing, { maxJumps, model });
  const candidates = mergeDetectionCandidates(floorCandidates, speed);
  const jumps: DetectedEvents[] = [];
  for (const cand of candidates) {
    if (jumps.length >= maxJumps) break;
    if (scoreJumpCycle(cand.touchdown, cand.takeoff, cand.landing).score >= 10) {
      jumps.push(eventsFromCandidate(cand));
    }
  }

  const diag: DetectDiagnostics = {
    ...base,
    candidates: [...candidates].sort((a, b) => b.score - a.score),
  };

  if (jumps.length === 0) {
    // Fall back: propose best single low-confidence jump if any.
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 3) {
      return {
        ok: true,
        model,
        jumps: [eventsFromCandidate(ranked[0])],
        lowConfidence: true,
        diagnostics: {
          ...diag,
          rejectStage: "ok",
          lowConfidence: true,
          notes: ["Low confidence multi-path fallback."],
        },
      };
    }
    return {
      ok: false,
      reason: "No plausible jump found. Mark touchdown, takeoff, and landing by hand.",
      diagnostics: { ...diag, rejectStage: "no_rebound" },
    };
  }
  return { ok: true, model, jumps, diagnostics: { ...diag, rejectStage: "ok" } };
}

export function refineFrames(events: DetectedEvents, step: number, frameCount: number): number[] {
  const frames = new Set<number>();
  const marks = [events.stepOff, events.touchdown, events.takeoff, events.landing];
  for (const event of marks) {
    if (event === null) continue;
    for (let f = event - step; f <= event + step; f += 1) {
      if (f >= 0 && f < frameCount) frames.add(f);
    }
  }
  return [...frames].sort((a, b) => a - b);
}

export function coarseFrames(frameCount: number, step: number): number[] {
  const frames: number[] = [];
  for (let f = 0; f < frameCount; f += step) frames.push(f);
  if (frameCount > 0 && frames[frames.length - 1] !== frameCount - 1) frames.push(frameCount - 1);
  return frames;
}
