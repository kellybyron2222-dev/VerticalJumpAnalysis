import type { DetectedEvents } from "./detect.ts";
import type { DetectCandidate } from "./detectDiag.ts";
import { realSecondsOnClock } from "./metrics.ts";

export interface JumpTimingContext {
  captureFps: number;
  stretch: number;
  frameTimes?: readonly number[];
}

export interface ResolvedJumpSet {
  jumps: DetectedEvents[];
  valid: DetectCandidate[];
  rejected: Array<DetectCandidate & { rejectReason: string }>;
  lowConfidence: boolean;
  notes: string[];
  implausible: boolean;
}

const MIN_CONTACT_S = 0.08;
const MAX_CONTACT_S = 1.0;
const PREFERRED_MAX_CONTACT_S = 0.6;
const MIN_FLIGHT_S = 0.15; // ~1 in jump height
const MIN_STAND_SEP_S = 0.12;
const MIN_FALL_S = 0.11;
const MAX_FALL_S = 0.45;

export function cycleRealDurations(
  c: Pick<DetectCandidate, "touchdown" | "takeoff" | "landing">,
  timing: JumpTimingContext,
): { contactS: number; flightS: number } {
  const contactS = realSecondsOnClock(
    timing.frameTimes,
    c.touchdown,
    c.takeoff,
    timing.captureFps,
    timing.stretch,
  );
  const flightS = realSecondsOnClock(
    timing.frameTimes,
    c.takeoff,
    c.landing,
    timing.captureFps,
    timing.stretch,
  );
  return { contactS, flightS };
}

/** Drop nonsense fragments before counting jumps. */
export function validateCandidateRealTime(
  c: DetectCandidate,
  timing: JumpTimingContext,
): { ok: boolean; reason: string; contactS: number; flightS: number } {
  if (!(c.touchdown < c.takeoff && c.takeoff < c.landing)) {
    return { ok: false, reason: "TD/TO/LD not distinct ascending", contactS: NaN, flightS: NaN };
  }
  if (c.takeoff - c.touchdown < 1 || c.landing - c.takeoff < 1) {
    return { ok: false, reason: "marks not distinct", contactS: NaN, flightS: NaN };
  }
  const { contactS, flightS } = cycleRealDurations(c, timing);
  if (!(contactS >= MIN_CONTACT_S && contactS <= MAX_CONTACT_S)) {
    return {
      ok: false,
      reason: `contact ${Number.isFinite(contactS) ? (contactS * 1000).toFixed(0) : "?"} ms (need 80–1000)`,
      contactS,
      flightS,
    };
  }
  if (!(flightS >= MIN_FLIGHT_S)) {
    return {
      ok: false,
      reason: `flight ${Number.isFinite(flightS) ? (flightS * 1000).toFixed(0) : "?"} ms (need ≥150)`,
      contactS,
      flightS,
    };
  }
  return { ok: true, reason: "ok", contactS, flightS };
}

/** True when A fully finishes and a clear standing gap precedes B (or vice versa). */
export function cyclesSeparated(
  a: DetectCandidate,
  b: DetectCandidate,
  timing: JumpTimingContext,
): boolean {
  const first = a.landing <= b.touchdown ? a : b;
  const second = a.landing <= b.touchdown ? b : a;
  if (first.landing >= second.touchdown) return false;
  // Overlap of contact/flight windows
  if (first.takeoff < second.landing && second.touchdown < first.landing) {
    // still check gap between landing and next TD
  }
  const gapS = realSecondsOnClock(
    timing.frameTimes,
    first.landing,
    second.touchdown,
    timing.captureFps,
    timing.stretch,
  );
  return gapS >= MIN_STAND_SEP_S;
}

export function candidatesOverlapOrAdjacent(
  a: DetectCandidate,
  b: DetectCandidate,
  timing: JumpTimingContext,
): boolean {
  if (a.touchdown <= b.landing && b.touchdown <= a.landing) return true;
  return !cyclesSeparated(a, b, timing);
}

/**
 * Merge overlapping/adjacent fragments into one drop-jump cycle:
 * TD = earliest touchdown, TO = start of the longest flight, LD = end of that flight
 * (extended to the latest landing if needed).
 */
export function mergeFragmentCandidates(
  candidates: readonly DetectCandidate[],
  stepOffHint: number | null = null,
): DetectedEvents | null {
  if (!candidates.length) return null;
  const touchdown = Math.min(...candidates.map((c) => c.touchdown));
  let best = candidates[0]!;
  let bestFlight = best.landing - best.takeoff;
  for (const c of candidates) {
    if (c.takeoff < touchdown) continue;
    const flight = c.landing - c.takeoff;
    if (flight > bestFlight) {
      best = c;
      bestFlight = flight;
    }
  }
  let takeoff = best.takeoff;
  let landing = Math.max(...candidates.map((c) => c.landing));
  if (takeoff <= touchdown) takeoff = touchdown + 1;
  if (landing <= takeoff) landing = takeoff + 1;
  const sos = candidates
    .map((c) => c.stepOff)
    .filter((v): v is number => typeof v === "number" && v >= 0 && v < touchdown);
  const stepOff =
    stepOffHint !== null && stepOffHint >= 0 && stepOffHint < touchdown
      ? stepOffHint
      : sos.length
        ? Math.min(...sos)
        : null;
  return { stepOff, touchdown, takeoff, landing };
}

/** Prefer a TD whose free-fall from step-off is 0.11–0.45 s real. */
export function touchdownFromFreeFall(
  stepOff: number,
  candidates: readonly DetectCandidate[],
  timing: JumpTimingContext,
): number | null {
  let bestTd: number | null = null;
  let bestErr = Infinity;
  const target = 0.18;
  for (const c of candidates) {
    if (c.touchdown <= stepOff) continue;
    const fall = realSecondsOnClock(
      timing.frameTimes,
      stepOff,
      c.touchdown,
      timing.captureFps,
      timing.stretch,
    );
    if (fall >= MIN_FALL_S && fall <= MAX_FALL_S) {
      const err = Math.abs(fall - target);
      if (err < bestErr) {
        bestErr = err;
        bestTd = c.touchdown;
      }
    }
  }
  return bestTd;
}

/**
 * Filter invalid cycles, require separation for multi-jump, otherwise merge to one.
 */
export function resolveJumpSet(
  candidates: readonly DetectCandidate[],
  timing: JumpTimingContext,
  options: { stepOffHint?: number | null } = {},
): ResolvedJumpSet {
  const notes: string[] = [];
  const rejected: Array<DetectCandidate & { rejectReason: string }> = [];
  const valid: DetectCandidate[] = [];

  for (const c of candidates) {
    const check = validateCandidateRealTime(c, timing);
    if (check.ok) {
      const preferred = check.contactS <= PREFERRED_MAX_CONTACT_S;
      valid.push(preferred ? c : { ...c, note: `${c.note ?? "ok"}; contact long`, score: c.score - 2 });
    } else {
      rejected.push({ ...c, rejectReason: check.reason });
    }
  }

  const stepOffHint = options.stepOffHint ?? null;

  // Free-fall anchor: if SO→TD looks real, keep only cycles at/after that TD for merge.
  let anchoredTd: number | null = null;
  if (stepOffHint !== null) {
    anchoredTd = touchdownFromFreeFall(stepOffHint, candidates, timing);
    if (anchoredTd !== null) {
      notes.push(`Free-fall anchor SO ${stepOffHint} → TD ${anchoredTd}.`);
    }
  }

  if (valid.length >= 2) {
    const sorted = [...valid].sort((a, b) => a.touchdown - b.touchdown);
    let separated = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (!cyclesSeparated(sorted[i - 1]!, sorted[i]!, timing)) {
        separated = false;
        break;
      }
    }
    if (separated) {
      return {
        jumps: sorted.map((c) => ({
          stepOff: c.stepOff,
          touchdown: c.touchdown,
          takeoff: c.takeoff,
          landing: c.landing,
        })),
        valid: sorted,
        rejected,
        lowConfidence: false,
        notes: [...notes, `Kept ${sorted.length} separated valid cycles.`],
        implausible: false,
      };
    }
    notes.push("Valid cycles overlap or touch — merging to one jump.");
  }

  // Single-jump path: merge fragments (valid + rejected that share the window).
  const mergePool =
    anchoredTd !== null
      ? candidates.filter((c) => c.touchdown >= anchoredTd! - 2 || c.landing > anchoredTd!)
      : [...candidates];
  const pool = mergePool.length ? mergePool : [...candidates];
  const merged = mergeFragmentCandidates(pool, stepOffHint);
  if (!merged) {
    return {
      jumps: [],
      valid,
      rejected,
      lowConfidence: true,
      notes: [...notes, "No mergeable candidates."],
      implausible: true,
    };
  }

  // If free-fall TD is known and earlier than merge TD, prefer it.
  if (anchoredTd !== null && anchoredTd < merged.touchdown) {
    merged.touchdown = anchoredTd;
    if (merged.takeoff <= merged.touchdown) merged.takeoff = merged.touchdown + 1;
    if (merged.landing <= merged.takeoff) merged.landing = merged.takeoff + 1;
  }
  if (stepOffHint !== null && stepOffHint < merged.touchdown) {
    merged.stepOff = stepOffHint;
  }

  const check = validateCandidateRealTime(
    { ...merged, score: 0, note: "merged" },
    timing,
  );
  if (!check.ok) {
    notes.push(`Merged jump still implausible (${check.reason}). Adjust marks.`);
    return {
      jumps: [merged],
      valid,
      rejected,
      lowConfidence: true,
      notes,
      implausible: true,
    };
  }

  notes.push(
    valid.length <= 1
      ? "Single valid cycle (or fragments merged)."
      : "Merged overlapping fragments into one jump.",
  );
  return {
    jumps: [merged],
    valid,
    rejected,
    lowConfidence: rejected.length > 0 && valid.length === 0,
    notes,
    implausible: false,
  };
}

export function isJumpImplausible(
  events: DetectedEvents,
  timing: JumpTimingContext,
): { implausible: boolean; reason: string } {
  const check = validateCandidateRealTime(
    {
      stepOff: events.stepOff,
      touchdown: events.touchdown,
      takeoff: events.takeoff,
      landing: events.landing,
      score: 0,
    },
    timing,
  );
  return { implausible: !check.ok, reason: check.reason };
}
