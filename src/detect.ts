/**
 * One pose sample. `footY` is the lowest visible foot point in normalized
 * image coordinates (0 = top, 1 = bottom), so a larger value is closer to the floor.
 */
export interface FootSample {
  frame: number;
  footY: number;
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
  touchdown: number;
  takeoff: number;
  landing: number;
}

export type Detection =
  | { ok: true; events: DetectedEvents; model: GroundModel }
  | { ok: false; reason: string };

const MIN_SAMPLES = 8;

function sortedSamples(samples: readonly FootSample[]): FootSample[] {
  const byFrame = new Map<number, number>();
  for (const sample of samples) {
    if (Number.isFinite(sample.frame) && Number.isFinite(sample.footY)) {
      byFrame.set(Math.round(sample.frame), sample.footY);
    }
  }
  return [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, footY]) => ({ frame, footY }));
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
  const ordered = sortedSamples(samples);
  const model = fixedModel ?? groundModel(ordered);
  if (!model) return { ok: false, reason: "Not enough frames with a visible foot." };

  const onGround = ordered.map((sample) => sample.footY >= model.ground - model.tolerance);

  let i = 0;
  while (i < ordered.length && onGround[i]) i += 1;
  if (i === ordered.length) return { ok: false, reason: "The feet never leave the floor." };

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

  const tdIndex = nextContact(i);
  if (tdIndex >= ordered.length) return { ok: false, reason: "No touchdown found." };
  const toIndex = nextAir(tdIndex);
  if (toIndex >= ordered.length) return { ok: false, reason: "No takeoff found." };
  const ldIndex = nextContact(toIndex);
  if (ldIndex >= ordered.length) return { ok: false, reason: "No landing found." };

  return {
    ok: true,
    model,
    events: {
      touchdown: ordered[tdIndex].frame,
      takeoff: ordered[toIndex].frame,
      landing: ordered[ldIndex].frame,
    },
  };
}

/** Frames to sample at full resolution around each coarse event. */
export function refineFrames(events: DetectedEvents, step: number, frameCount: number): number[] {
  const frames = new Set<number>();
  for (const event of [events.touchdown, events.takeoff, events.landing]) {
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
