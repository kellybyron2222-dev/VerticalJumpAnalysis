/**
 * One pose sample. `footY` is the lowest visible foot point in normalized
 * image coordinates (0 = top, 1 = bottom), so a larger value is closer to the floor.
 */
export interface FootSample {
  frame: number;
  footY: number;
  /** Lowest point of the higher foot, when both feet are visible. The trailing foot leaves the box last. */
  upperFootY?: number;
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
      const upper = sample.upperFootY;
      byFrame.set(
        frame,
        upper !== undefined && Number.isFinite(upper)
          ? { frame, footY: sample.footY, upperFootY: upper }
          : { frame, footY: sample.footY },
      );
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
  return sorted[index];
}

/**
 * Floor level is a high quantile of foot height rather than the max, so one
 * bad landmark below the floor does not move it.
 */
export function groundModel(samples: readonly FootSample[]): GroundModel | null {
  const ordered = sortedSamples(samples);
  if (ordered.length < MIN_SAMPLES) return null;
  const ys = ordered.map((sample) => sample.footY);
  const ground = quantile(ys, 0.9);
  const head = ys.slice(0, Math.max(3, Math.floor(ys.length * 0.1)));
  const start = quantile(head, 0.5);
  const drop = ground - start;
  const tolerance = Math.min(0.03, Math.max(0.006, drop * 0.15));
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
      if (lastAirFrame - ordered[index].frame >= minAirFrames) return index;
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
    if (level(ordered[k]) <= box + tolerance) return ordered[k].frame;
  }
  return null;
}

/**
 * Finds the first floor contact after leaving the box, the takeoff from it,
 * and the next floor contact. Frames are the first frame of each state:
 * touchdown and landing are the first frames on the floor, takeoff is the
 * first frame off it. Output depends only on the samples, so identical input
 * always gives identical marks.
 */
export function detectEvents(
  samples: readonly FootSample[],
  fixedModel?: GroundModel,
  minAirFrames = 6,
): Detection {
  const all = detectAllEvents(samples, { fixedModel, minAirFrames, maxJumps: 1 });
  if (!all.ok) return all;
  const events = all.jumps[0];
  if (!events) return { ok: false, reason: "No jump found." };
  return { ok: true, model: all.model, events };
}

export type MultiDetection =
  | { ok: true; jumps: DetectedEvents[]; model: GroundModel }
  | { ok: false; reason: string };

/**
 * Find every drop/depth cycle in one clip. Splits between jumps on standing
 * periods after landing (minStandFrames on the floor before the next leave).
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
  if (!model) return { ok: false, reason: "Not enough frames with a visible foot." };

  const onGround = ordered.map((sample) => sample.footY >= model.ground - model.tolerance);
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
      touchdown: ordered[tdIndex].frame,
      takeoff: ordered[toIndex].frame,
      landing: ordered[ldIndex].frame,
    });

    // Standing run after landing separates jumps.
    let stand = 0;
    let j = ldIndex;
    while (j < ordered.length && onGround[j]) {
      stand += 1;
      j += 1;
    }
    searchFrom = ldIndex;
    if (stand < minStandFrames) {
      // Not enough still time — continue after this landing without treating the next leave as a clean split.
      i = Math.min(ordered.length, ldIndex + 1);
      continue;
    }
    i = ldIndex;
  }

  if (jumps.length === 0) return { ok: false, reason: "No jump found." };
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
