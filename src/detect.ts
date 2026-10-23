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
  | { ok: true; events: DetectedEvents; model: GroundModel }
  | { ok: false; reason: string };

const MIN_SAMPLES = 8;

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

/**
 * Last frame at box level before touchdown. Box level is the median of the
 * first tenth of the clip; the tolerance is tight because free fall starts
 * slowly, so a loose one would mark step-off late.
 */
function findStepOff(ordered: readonly FootSample[], tdIndex: number, ground: number): number | null {
  const level = (sample: FootSample) => sample.upperFootY ?? sample.footY;
  const head = ordered.slice(0, Math.max(3, Math.floor(ordered.length * 0.1))).map(level);
  const box = quantile(head, 0.5);
  const drop = ground - box;
  if (drop < 0.02) return null;
  const tolerance = Math.min(0.01, Math.max(0.003, drop * 0.03));
  for (let k = tdIndex - 1; k >= 0; k -= 1) {
    if (level(ordered[k]) <= box + tolerance) return ordered[k].frame;
  }
  return null;
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index]!;
}

/**
 * Floor level is a high quantile of the contact signal. Prefer the latter
 * part of the clip so a mid-drop start (already falling at frame 0) does not
 * pull the floor estimate up toward the box.
 */
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
  // Mid-drop starts have a small apparent drop; keep a usable contact band.
  const tolerance = Math.min(0.045, Math.max(0.012, Math.abs(drop) * 0.25 || 0.02));
  return { ground, start, tolerance };
}

function contactHelpers(ordered: readonly FootSample[], onGround: readonly boolean[], minAirFrames: number) {
  const nextContact = (from: number): number => {
    let index = from;
    while (index < ordered.length && !onGround[index]) index += 1;
    return index;
  };
  // Brief foot blips off the floor during contact are landmark noise, not a takeoff.
  const nextAir = (from: number): number => {
    let index = from;
    while (index < ordered.length) {
      while (index < ordered.length && onGround[index]) index += 1;
      if (index >= ordered.length) return index;
      const back = nextContact(index);
      const lastAirFrame = back < ordered.length ? ordered[back].frame : Infinity;
      if (lastAirFrame - ordered[index]!.frame >= minAirFrames) return index;
      index = back;
    }
    return index;
  };
  return { nextContact, nextAir };
}

/**
 * Last frame on the box before touchdown, searching only within [fromIndex, tdIndex).
 */
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
  if (drop < 0.02) return null;
  const tolerance = Math.min(0.01, Math.max(0.003, drop * 0.03));
  for (let k = tdIndex - 1; k >= fromIndex; k -= 1) {
    if (level(ordered[k]!) <= box + tolerance) return ordered[k]!.frame;
  }
  return null;
}

function buildOnGround(ordered: readonly FootSample[], model: GroundModel): boolean[] {
  return ordered.map((sample) => sample.footY >= model.ground - model.tolerance);
}

/**
 * Classic single-jump detector. Handles clips that start mid-drop (already
 * in the air at frame 0) — no standing period is required before touchdown.
 */
export function detectEvents(
  samples: readonly FootSample[],
  fixedModel?: GroundModel,
  minAirFrames = 6,
): Detection {
  const ordered = sortedSamples(samples);
  const model = fixedModel ?? groundModel(ordered);
  if (!model) {
    return {
      ok: false,
      reason:
        "Not enough pose samples with a visible body. Try again, or mark touchdown, takeoff, and landing by hand.",
    };
  }

  const onGround = buildOnGround(ordered, model);
  const { nextContact, nextAir } = contactHelpers(ordered, onGround, minAirFrames);

  // Start mid-air (common when the recording begins at step-off): do not skip.
  // Start on the box/floor: skip to the first leave, then find touchdown.
  let i = 0;
  while (i < ordered.length && onGround[i]) i += 1;
  if (i === ordered.length) {
    return {
      ok: false,
      reason:
        "Could not see the feet leave the floor. Mark step-off, touchdown, takeoff, and landing by hand.",
    };
  }

  const tdIndex = nextContact(i);
  if (tdIndex >= ordered.length) {
    return {
      ok: false,
      reason: "No touchdown found. Mark touchdown, takeoff, and landing by hand.",
    };
  }
  const toIndex = nextAir(tdIndex);
  if (toIndex >= ordered.length) {
    return {
      ok: false,
      reason: "No takeoff found after contact. Mark takeoff and landing by hand.",
    };
  }
  const ldIndex = nextContact(toIndex);
  if (ldIndex >= ordered.length) {
    return {
      ok: false,
      reason: "No landing found after the flight. Mark landing by hand.",
    };
  }

  return {
    ok: true,
    model,
    events: {
      stepOff: findStepOff(ordered, tdIndex, model.ground),
      touchdown: ordered[tdIndex]!.frame,
      takeoff: ordered[toIndex]!.frame,
      landing: ordered[ldIndex]!.frame,
    },
  };
}

export type MultiDetection =
  | { ok: true; jumps: DetectedEvents[]; model: GroundModel }
  | { ok: false; reason: string };

/**
 * Find every drop/depth cycle in one clip. Splits between jumps on standing
 * periods after landing. Not used for single-jump clips (see detectEvents).
 */
export function detectAllEvents(
  samples: readonly FootSample[],
  options: {
    fixedModel?: GroundModel;
    minAirFrames?: number;
    minStandFrames?: number;
    maxJumps?: number;
  } = {},
): MultiDetection {
  const minAirFrames = options.minAirFrames ?? 6;
  const minStandFrames = options.minStandFrames ?? 12;
  const maxJumps = options.maxJumps ?? 8;
  const ordered = sortedSamples(samples);
  const model = options.fixedModel ?? groundModel(ordered);
  if (!model) {
    return {
      ok: false,
      reason:
        "Not enough pose samples with a visible body. Try again, or mark events by hand.",
    };
  }

  const onGround = buildOnGround(ordered, model);
  const { nextContact, nextAir } = contactHelpers(ordered, onGround, minAirFrames);
  const jumps: DetectedEvents[] = [];
  let i = 0;
  let searchFrom = 0;

  while (jumps.length < maxJumps && i < ordered.length) {
    while (i < ordered.length && onGround[i]) i += 1;
    if (i >= ordered.length) break;

    const tdIndex = nextContact(i);
    if (tdIndex >= ordered.length) break;
    const toIndex = nextAir(tdIndex);
    if (toIndex >= ordered.length) break;
    const ldIndex = nextContact(toIndex);
    if (ldIndex >= ordered.length) break;

    jumps.push({
      stepOff: findStepOffInRange(ordered, tdIndex, searchFrom, model.ground),
      touchdown: ordered[tdIndex]!.frame,
      takeoff: ordered[toIndex]!.frame,
      landing: ordered[ldIndex]!.frame,
    });

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

  if (jumps.length === 0) {
    return {
      ok: false,
      reason: "No jump cycle found. Mark touchdown, takeoff, and landing by hand.",
    };
  }
  return { ok: true, model, jumps };
}

/** Frames to sample at full resolution around each coarse event. */
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
