import type { DetectedEvents } from "./detect.ts";
import type { DetectCandidate } from "./detectDiag.ts";
import type { JumpCountChoice } from "./jumpCountPref.ts";
import {
  jumpHeightMeters,
  metersToInches,
  realSecondsOnClock,
} from "./metrics.ts";

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
  /** Soft flags — do not hide the jump; surface in UI. */
  warnings: string[];
}

const MIN_CONTACT_S = 0.08;
const MAX_CONTACT_S = 1.0;
const PREFERRED_MAX_CONTACT_S = 0.6;
const MIN_FLIGHT_S = 0.15; // ~1 in jump height
const MIN_STAND_SEP_S = 0.12;
const MIN_FALL_S = 0.11;
const MAX_FALL_S = 0.45;

/** Auto: drop weak / settling “reps”. */
const MIN_REP_HEIGHT_IN = 4;
const MIN_REP_RSI = 0.5;
const MIN_REP_HEIGHT_FRAC = 0.4;
const MIN_DROP_FALL_S = 0.08;
const MAX_DROP_FALL_S = 0.55;
const FLAG_FLIGHT_S = 0.65;
const FLAG_HEIGHT_IN = 30;

/** Soft “Check marks” band (stricter than hard gates; does not reject). */
const CHECK_CONTACT_MIN_S = 0.1;
const CHECK_CONTACT_MAX_S = 0.6;
const CHECK_FLIGHT_MIN_S = 0.15;
const CHECK_FLIGHT_MAX_S = 0.8;

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

export function cycleMetrics(
  c: Pick<DetectCandidate, "touchdown" | "takeoff" | "landing">,
  timing: JumpTimingContext,
): { contactS: number; flightS: number; heightIn: number; rsi: number } {
  const { contactS, flightS } = cycleRealDurations(c, timing);
  const heightM = jumpHeightMeters(flightS);
  const heightIn = metersToInches(heightM);
  const rsi = contactS > 0 ? heightM / contactS : 0;
  return { contactS, flightS, heightIn, rsi };
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

/**
 * Real drop/step-off (meaningful free-fall) or mid-drop / CM with no SO mark.
 * A 1-frame "SO" right before TD is not a drop (walking/settling).
 */
export function hasDropOrCountermovement(
  c: DetectCandidate,
  timing: JumpTimingContext,
): boolean {
  if (c.stepOff === null || c.stepOff >= c.touchdown) {
    // Mid-drop start or countermovement — allowed; Auto height/RSI filters still apply.
    return true;
  }
  const fall = realSecondsOnClock(
    timing.frameTimes,
    c.stepOff,
    c.touchdown,
    timing.captureFps,
    timing.stretch,
  );
  return fall >= MIN_DROP_FALL_S && fall <= MAX_DROP_FALL_S;
}

/** Auto-only: drop tiny / settling cycles vs the best rep. */
export function filterAutoReps(
  valid: readonly DetectCandidate[],
  timing: JumpTimingContext,
  options: { requireDrop?: boolean } = {},
): { kept: DetectCandidate[]; rejected: Array<DetectCandidate & { rejectReason: string }> } {
  const requireDrop = options.requireDrop !== false;
  const rejected: Array<DetectCandidate & { rejectReason: string }> = [];
  const withDrop: DetectCandidate[] = [];
  for (const c of valid) {
    if (requireDrop && !hasDropOrCountermovement(c, timing)) {
      rejected.push({ ...c, rejectReason: "no real drop/step-off or countermovement" });
      continue;
    }
    withDrop.push(c);
  }
  if (!withDrop.length) return { kept: [], rejected };

  const metrics = withDrop.map((c) => ({ c, m: cycleMetrics(c, timing) }));
  const bestHeight = Math.max(...metrics.map((x) => x.m.heightIn));
  const kept: DetectCandidate[] = [];
  for (const { c, m } of metrics) {
    if (!(m.heightIn >= MIN_REP_HEIGHT_IN)) {
      rejected.push({ ...c, rejectReason: `height ${m.heightIn.toFixed(1)} in < ${MIN_REP_HEIGHT_IN}` });
      continue;
    }
    if (!(m.rsi >= MIN_REP_RSI)) {
      rejected.push({ ...c, rejectReason: `RSI ${m.rsi.toFixed(2)} < ${MIN_REP_RSI}` });
      continue;
    }
    if (bestHeight > 0 && m.heightIn < bestHeight * MIN_REP_HEIGHT_FRAC) {
      rejected.push({
        ...c,
        rejectReason: `height ${m.heightIn.toFixed(1)} in < 40% of best (${bestHeight.toFixed(1)})`,
      });
      continue;
    }
    kept.push(c);
  }
  return { kept, rejected };
}

export function landingCheckWarnings(
  jumps: readonly DetectedEvents[],
  timing: JumpTimingContext,
): string[] {
  const warnings: string[] = [];
  jumps.forEach((j, i) => {
    const m = cycleMetrics(j, timing);
    const label = jumps.length > 1 ? `Jump ${i + 1}` : "Jump";
    if (m.flightS > FLAG_FLIGHT_S || m.heightIn > FLAG_HEIGHT_IN) {
      warnings.push(
        `${label}: check LD mark: landing may be late` +
          ` (flight ${(m.flightS * 1000).toFixed(0)} ms, height ${m.heightIn.toFixed(1)} in).`,
      );
    }
    if (
      !(m.contactS >= CHECK_CONTACT_MIN_S && m.contactS <= CHECK_CONTACT_MAX_S) ||
      !(m.flightS >= CHECK_FLIGHT_MIN_S && m.flightS <= CHECK_FLIGHT_MAX_S)
    ) {
      warnings.push(
        `Check marks: ${label} contact ${(m.contactS * 1000).toFixed(0)} ms / flight ${(m.flightS * 1000).toFixed(0)} ms ` +
          `(typical contact 100–600 ms, flight 150–800 ms). Use Set on each event.`,
      );
    }
  });
  return warnings;
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

/**
 * Approach (one-step / penultimate): plant = last ground contact before the
 * biggest valid flight — i.e. the TD/TO/LD of the valid cycle with the longest
 * real flight. Never invents an earliest-TD merge (that yields 4 ms "contact").
 */
export function pickApproachPlant(
  candidates: readonly DetectCandidate[],
  timing: JumpTimingContext,
): DetectedEvents | null {
  if (!candidates.length) return null;
  const ranked = candidates.map((c) => {
    const check = validateCandidateRealTime(c, timing);
    return { c, check };
  });
  const valid = ranked.filter((x) => x.check.ok);
  const pool = valid.length ? valid : ranked.filter((x) => Number.isFinite(x.check.flightS));
  if (!pool.length) return null;
  pool.sort(
    (a, b) =>
      (b.check.flightS || 0) - (a.check.flightS || 0) ||
      b.c.score - a.c.score ||
      b.c.touchdown - a.c.touchdown,
  );
  return toEvents(pool[0]!.c);
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

function toEvents(c: DetectCandidate): DetectedEvents {
  return {
    stepOff: c.stepOff,
    touchdown: c.touchdown,
    takeoff: c.takeoff,
    landing: c.landing,
  };
}

/**
 * Filter invalid cycles; Auto drops weak settling reps; fixed N takes N best by score.
 */
export function resolveJumpSet(
  candidates: readonly DetectCandidate[],
  timing: JumpTimingContext,
  options: {
    stepOffHint?: number | null;
    jumpCount?: JumpCountChoice;
    /** When false (one-step / penultimate), do not require a box drop. Default true. */
    requireDrop?: boolean;
  } = {},
): ResolvedJumpSet {
  const notes: string[] = [];
  const rejected: Array<DetectCandidate & { rejectReason: string }> = [];
  const valid: DetectCandidate[] = [];
  const jumpCount: JumpCountChoice = options.jumpCount ?? "auto";

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
  const requireDrop = options.requireDrop !== false;

  let anchoredTd: number | null = null;
  // Free-fall SO→TD anchoring is drop/depth only — never for approach.
  if (requireDrop && stepOffHint !== null) {
    anchoredTd = touchdownFromFreeFall(stepOffHint, candidates, timing);
    if (anchoredTd !== null) {
      notes.push(`Free-fall anchor SO ${stepOffHint} → TD ${anchoredTd}.`);
    }
  }

  // Fixed N: exactly N best-scoring valid cycles, in time order (no Auto quality filter).
  if (jumpCount !== "auto") {
    const n = jumpCount;
    const best = [...valid].sort((a, b) => b.score - a.score || a.touchdown - b.touchdown).slice(0, n);
    const ordered = [...best].sort((a, b) => a.touchdown - b.touchdown);
    if (!ordered.length) {
      return {
        jumps: [],
        valid,
        rejected,
        lowConfidence: true,
        notes: [...notes, `Asked for ${n} jump(s) but none were valid.`],
        implausible: true,
        warnings: [],
      };
    }
    const jumps = ordered.map(toEvents);
    const warnings = landingCheckWarnings(jumps, timing);
    notes.push(`Jumps in clip = ${n}: kept ${jumps.length} best-scoring valid cycle(s).`);
    return {
      jumps,
      valid: ordered,
      rejected,
      lowConfidence: jumps.length < n,
      notes,
      implausible: false,
      warnings,
    };
  }

  // Auto: quality-filter then keep up to 4 separated reps.
  // Approach (requireDrop=false) never applies drop/step-off/countermovement filter.
  const auto = filterAutoReps(valid, timing, { requireDrop });
  rejected.push(...auto.rejected);
  for (const r of auto.rejected) {
    notes.push(`Auto dropped TD${r.touchdown}: ${r.rejectReason}`);
  }
  const reps = auto.kept;

  // Approach: always plant = biggest valid flight (never drop-merge / multi-rep split).
  if (!requireDrop) {
    const plant = pickApproachPlant(reps.length ? reps : valid.length ? valid : candidates, timing);
    if (!plant) {
      return {
        jumps: [],
        valid,
        rejected,
        lowConfidence: true,
        notes: [...notes, "No approach plant candidate."],
        implausible: true,
        warnings: [],
      };
    }
    const check = validateCandidateRealTime({ ...plant, score: 0, note: "approach plant" }, timing);
    if (!check.ok) {
      notes.push(`Approach plant still implausible (${check.reason}). Fall back to manual marks.`);
      return {
        jumps: [],
        valid,
        rejected,
        lowConfidence: true,
        notes,
        implausible: true,
        warnings: [],
      };
    }
    const flightMs = check.flightS * 1000;
    let largestFlightMs = flightMs;
    for (const c of valid.length ? valid : candidates) {
      const f = cycleRealDurations(c, timing).flightS * 1000;
      if (Number.isFinite(f) && f > largestFlightMs) largestFlightMs = f;
    }
    notes.push(
      `Approach plant TD${plant.touchdown} TO${plant.takeoff} LD${plant.landing}` +
        ` (flight ${flightMs.toFixed(0)} ms; largest clip flight ${largestFlightMs.toFixed(0)} ms).`,
    );
    const jumps = [plant];
    const warnings = landingCheckWarnings(jumps, timing);
    if (flightMs < largestFlightMs * 0.85) {
      warnings.push(
        `Check marks: plant flight ${flightMs.toFixed(0)} ms < 85% of largest clip flight ${largestFlightMs.toFixed(0)} ms — verify plant/TO/LD.`,
      );
    }
    return {
      jumps,
      valid,
      rejected,
      lowConfidence:
        (rejected.length > 0 && valid.length === 0) ||
        warnings.some((w) => /Check marks/i.test(w)),
      notes,
      implausible: false,
      warnings,
    };
  }

  if (reps.length >= 2) {
    const sorted = [...reps].sort((a, b) => a.touchdown - b.touchdown);
    let separated = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (!cyclesSeparated(sorted[i - 1]!, sorted[i]!, timing)) {
        separated = false;
        break;
      }
    }
    if (separated) {
      const limited = sorted.slice(0, 4);
      const jumps = limited.map(toEvents);
      const warnings = landingCheckWarnings(jumps, timing);
      return {
        jumps,
        valid: limited,
        rejected,
        lowConfidence: false,
        notes: [...notes, `Auto kept ${limited.length} separated rep(s).`],
        implausible: false,
        warnings,
      };
    }
    notes.push("Valid cycles overlap or touch — merging to one jump.");
  }

  // Single-jump path: prefer best Auto rep; else merge fragments.
  if (reps.length === 1) {
    const jumps = [toEvents(reps[0]!)];
    const warnings = landingCheckWarnings(jumps, timing);
    return {
      jumps,
      valid: reps,
      rejected,
      lowConfidence: false,
      notes: [
        ...notes,
        `Auto kept one rep TD${reps[0]!.touchdown} TO${reps[0]!.takeoff} LD${reps[0]!.landing}.`,
      ],
      implausible: false,
      warnings,
    };
  }

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
      warnings: [],
    };
  }

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
    notes.push(`Merged jump still implausible (${check.reason}). Fall back to manual marks.`);
    return {
      jumps: [],
      valid,
      rejected,
      lowConfidence: true,
      notes,
      implausible: true,
      warnings: [],
    };
  }

  notes.push(
    valid.length <= 1
      ? "Single valid cycle (or fragments merged)."
      : "Merged overlapping fragments into one jump.",
  );
  const jumps = [merged];
  return {
    jumps,
    valid,
    rejected,
    lowConfidence: rejected.length > 0 && valid.length === 0,
    notes,
    implausible: false,
    warnings: landingCheckWarnings(jumps, timing),
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
