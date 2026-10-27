import type { DetectedEvents } from "./detect.ts";

export type RejectStage =
  | "no_samples"
  | "no_drop"
  | "no_rebound"
  | "flight_too_short"
  | "contact_out_of_range"
  | "free_fall_check"
  | "ok";

export interface DetectCandidate {
  stepOff: number | null;
  touchdown: number;
  takeoff: number;
  landing: number;
  score: number;
  note?: string;
}

export interface DetectDiagnostics {
  framesScanned: number;
  framesWithPerson: number;
  medianAnkleVis: number | null;
  medianHeelVis: number | null;
  medianKneeVis: number | null;
  medianHipVis: number | null;
  hipYMin: number | null;
  hipYMax: number | null;
  rejectStage: RejectStage;
  candidates: DetectCandidate[];
  lowConfidence: boolean;
  notes: string[];
  /** Active jump type when Auto ran (shown at top of diagnostics). */
  jumpType?: string;
}

export function emptyDiagnostics(partial: Partial<DetectDiagnostics> = {}): DetectDiagnostics {
  return {
    framesScanned: 0,
    framesWithPerson: 0,
    medianAnkleVis: null,
    medianHeelVis: null,
    medianKneeVis: null,
    medianHipVis: null,
    hipYMin: null,
    hipYMax: null,
    rejectStage: "no_samples",
    candidates: [],
    lowConfidence: false,
    notes: [],
    ...partial,
  };
}

export function formatDetectDiagnostics(diag: DetectDiagnostics): string {
  const vis = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const hip =
    diag.hipYMin !== null && diag.hipYMax !== null
      ? `${diag.hipYMin.toFixed(3)}–${diag.hipYMax.toFixed(3)}`
      : "—";
  const lines = [
    `Jump type: ${diag.jumpType ?? "—"}`,
    `Frames scanned: ${diag.framesScanned}`,
    `Frames with person: ${diag.framesWithPerson}`,
    `Median visibility — ankle ${vis(diag.medianAnkleVis)}, heel ${vis(diag.medianHeelVis)}, knee ${vis(diag.medianKneeVis)}, hip ${vis(diag.medianHipVis)}`,
    `Hip Y range: ${hip}`,
    `Reject stage: ${diag.rejectStage}`,
    `Low confidence: ${diag.lowConfidence ? "yes" : "no"}`,
  ];
  if (diag.candidates.length) {
    lines.push("Candidates:");
    for (const c of diag.candidates.slice(0, 6)) {
      lines.push(
        `  score ${c.score.toFixed(1)} · TD ${c.touchdown} TO ${c.takeoff} LD ${c.landing}` +
          (c.stepOff !== null ? ` SO ${c.stepOff}` : "") +
          (c.note ? ` (${c.note})` : ""),
      );
    }
  } else {
    lines.push("Candidates: none");
  }
  if (diag.notes.length) lines.push(...diag.notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Score a TD/TO/LD cycle. Higher is better; ≥10 confident, ≥3 proposable. */
export function scoreJumpCycle(
  touchdown: number,
  takeoff: number,
  landing: number,
): { score: number; stage: RejectStage; note: string } {
  if (!(touchdown < takeoff && takeoff < landing)) {
    return { score: 0, stage: "no_rebound", note: "marks out of order" };
  }
  const contact = takeoff - touchdown;
  const flight = landing - takeoff;
  let score = 0;
  let stage: RejectStage = "ok";
  let note = "ok";

  if (contact < 1) {
    return { score: 0, stage: "contact_out_of_range", note: "contact < 1 frame" };
  }
  // Long "contact" is usually standing/walking after a false touchdown — reject.
  if (contact > 100) {
    return { score: 1, stage: "contact_out_of_range", note: "contact too long (walk/stand?)" };
  }
  if (contact >= 2 && contact <= 80) {
    score += 12;
  } else {
    score += 4;
    note = "contact marginal";
    if (stage === "ok") stage = "contact_out_of_range";
  }

  if (flight < 2) {
    return { score: Math.min(score, 2), stage: "flight_too_short", note: "flight < 2 frames" };
  }
  if (flight < 4) {
    score += 3;
    if (stage === "ok") {
      stage = "flight_too_short";
      note = "flight short";
    }
  } else if (flight <= 220) {
    score += 12 + Math.min(8, flight / 20);
  } else {
    score += 4;
    if (stage === "ok") note = "flight long";
  }

  // Prefer jumps later in a walking lead-in (first leave is often a step).
  score += Math.min(6, touchdown / 80);
  return { score, stage: score >= 10 ? "ok" : stage, note };
}

export function eventsFromCandidate(c: DetectCandidate): DetectedEvents {
  return {
    stepOff: c.stepOff,
    touchdown: c.touchdown,
    takeoff: c.takeoff,
    landing: c.landing,
  };
}
