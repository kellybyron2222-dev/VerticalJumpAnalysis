/**
 * Label-agnostic approach plant + penultimate marks.
 *
 * Plant TO / landing: longest flight from any-foot floor contact.
 * Plant TD: walk BACKWARD from TO in the continuous planted window
 * (y near floor + y-velocity near zero; bridge ≤2 frames only).
 * Plant contact must be 200–450 ms; otherwise try the next flight window.
 * Pen TO = end of the previous floor-contact window before plant TD.
 */
import { groundModel, type FootSample, type GroundModel } from "./detect.ts";
import { realSecondsOnClock } from "./metrics.ts";

export interface ApproachTiming {
  fps: number;
  stretch?: number;
  frameTimes?: readonly number[];
}

export interface ApproachDetectResult {
  touchdown: number;
  takeoff: number;
  landing: number;
  penTouchdown: number | null;
  penTakeoff: number | null;
  penTdBeforeClip: boolean;
  plantContactMs: number | null;
  flightMs: number | null;
  stepGapMs: number | null;
  reason: string;
}

export const PLANT_CONTACT_MIN_MS = 200;
export const PLANT_CONTACT_MAX_MS = 450;
export const MAX_BRIDGE_FRAMES = 2;

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

function anyFootY(s: FootSample): number {
  let best = s.footY;
  for (const y of [s.heelY, s.leftFootY, s.rightFootY, s.leftHeelY, s.rightHeelY]) {
    if (y !== undefined && Number.isFinite(y) && y > best) best = y;
  }
  return best;
}

function buildFloorContact(
  ordered: readonly FootSample[],
  model: GroundModel,
): boolean[] {
  const floor = model.ground;
  const tol = Math.max(model.tolerance, 0.025);
  return ordered.map((s) => anyFootY(s) >= floor - tol);
}

/** Planted = near floor AND low |y-velocity| (rejects swing-through in the step gap). */
function buildPlantedContact(
  ordered: readonly FootSample[],
  model: GroundModel,
): boolean[] {
  const ys = ordered.map(anyFootY);
  const floor = model.ground;
  const tol = Math.max(model.tolerance, 0.032);
  return ys.map((y, i) => {
    if (y < floor - tol) return false;
    let vel = 0;
    if (i > 0 && i < ordered.length - 1) {
      const dt = Math.max(1, ordered[i + 1]!.frame - ordered[i - 1]!.frame);
      vel = (ys[i + 1]! - ys[i - 1]!) / dt;
    } else if (i > 0) {
      const dt = Math.max(1, ordered[i]!.frame - ordered[i - 1]!.frame);
      vel = (y - ys[i - 1]!) / dt;
    }
    return Math.abs(vel) <= 0.022;
  });
}

function fillHoles(
  frames: readonly number[],
  on: readonly boolean[],
  maxHole = MAX_BRIDGE_FRAMES,
): boolean[] {
  const out = [...on];
  let lastOn = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (!out[i]) continue;
    if (lastOn >= 0) {
      const gapFrames = frames[i]! - frames[lastOn]! - 1;
      if (gapFrames > 0 && gapFrames <= maxHole) {
        for (let k = lastOn + 1; k < i; k += 1) out[k] = true;
      }
    }
    lastOn = i;
  }
  return out;
}

interface Streak {
  tdIdx: number;
  toIdx: number;
}

function streaksOf(frames: readonly number[], on: readonly boolean[]): Streak[] {
  const filled = fillHoles(frames, on, MAX_BRIDGE_FRAMES);
  const out: Streak[] = [];
  let i = 0;
  while (i < frames.length) {
    if (!filled[i]) {
      i += 1;
      continue;
    }
    const tdIdx = i;
    while (i < frames.length && filled[i]) i += 1;
    out.push({ tdIdx, toIdx: i - 1 });
  }
  return out;
}

function tdWalkBack(
  frames: readonly number[],
  filled: readonly boolean[],
  toIdx: number,
): number {
  let i = toIdx;
  if (!filled[i]) {
    while (i > 0 && !filled[i]) i -= 1;
    if (!filled[i]) return frames[toIdx]!;
  }
  while (i > 0 && filled[i - 1]) i -= 1;
  return frames[i]!;
}

function inPlantBand(ms: number | null): boolean {
  return ms !== null && ms >= PLANT_CONTACT_MIN_MS && ms <= PLANT_CONTACT_MAX_MS;
}

export function detectApproachFromPose(
  samples: readonly FootSample[],
  timing: ApproachTiming,
): ApproachDetectResult | null {
  const ordered = orderedSamples(samples);
  if (ordered.length < 12) return null;
  const model = groundModel(ordered);
  if (!model) return null;

  const frames = ordered.map((s) => s.frame);
  const floorOn = buildFloorContact(ordered, model);
  const flightStreaks = streaksOf(frames, floorOn);
  if (flightStreaks.length < 1) return null;

  type FlightCand = {
    takeoff: number;
    landing: number;
    toIdx: number;
    flightMs: number;
  };
  const flights: FlightCand[] = [];
  for (let i = 0; i < flightStreaks.length - 1; i += 1) {
    const plant = flightStreaks[i]!;
    const land = flightStreaks[i + 1]!;
    const takeoff = frames[plant.toIdx]!;
    const landing = frames[land.tdIdx]!;
    if (!(landing > takeoff + 2)) continue;
    const flightMs = realMs(timing, takeoff, landing);
    if (flightMs === null || flightMs < 150) continue;
    flights.push({ takeoff, landing, toIdx: plant.toIdx, flightMs });
  }
  if (!flights.length) return null;
  flights.sort((a, b) => b.flightMs - a.flightMs);

  const planted = buildPlantedContact(ordered, model);
  const plantedFilled = fillHoles(frames, planted, MAX_BRIDGE_FRAMES);
  const plantedStreaks = streaksOf(frames, planted);

  let chosen: {
    takeoff: number;
    landing: number;
    plantTd: number;
    plantMs: number;
  } | null = null;

  for (const fl of flights) {
    // 1) Walk back from TO in planted window (bridge ≤2).
    let plantTd = tdWalkBack(frames, plantedFilled, fl.toIdx);
    let plantMs = realMs(timing, plantTd, fl.takeoff);
    if (!inPlantBand(plantMs) || !(plantTd < fl.takeoff)) {
      // 2) Next window: planted streak that contains TO (no cross-gap walk).
      const containing = plantedStreaks.find(
        (st) => st.tdIdx <= fl.toIdx && fl.toIdx <= st.toIdx,
      );
      if (!containing) continue;
      plantTd = frames[containing.tdIdx]!;
      plantMs = realMs(timing, plantTd, fl.takeoff);
      if (!inPlantBand(plantMs) || !(plantTd < fl.takeoff)) continue;
    }
    chosen = {
      takeoff: fl.takeoff,
      landing: fl.landing,
      plantTd,
      plantMs: plantMs!,
    };
    break;
  }

  if (!chosen) {
    // Keep TO/LD from longest flight; TD from planted streak containing TO if any.
    const fl = flights[0]!;
    const containing = plantedStreaks.find(
      (st) => st.tdIdx <= fl.toIdx && fl.toIdx <= st.toIdx,
    );
    const plantTd = containing
      ? frames[containing.tdIdx]!
      : tdWalkBack(frames, plantedFilled, fl.toIdx);
    const plantMs = realMs(timing, plantTd, fl.takeoff) ?? 0;
    chosen = { takeoff: fl.takeoff, landing: fl.landing, plantTd, plantMs };
  }

  // Penultimate TO = end of prior floor streak with gap ≥60 ms before plant TD.
  const penStreaks = streaksOf(frames, floorOn);
  let penTouchdown: number | null = null;
  let penTakeoff: number | null = null;
  let penTdBeforeClip = false;
  let prevIdx = -1;
  for (let i = 0; i < penStreaks.length; i += 1) {
    const to = frames[penStreaks[i]!.toIdx]!;
    if (!(to < chosen.plantTd)) break;
    const gap = realMs(timing, to, chosen.plantTd);
    if (gap === null || gap < 60) continue;
    prevIdx = i;
    penTakeoff = to;
    penTouchdown = frames[penStreaks[i]!.tdIdx]!;
  }
  if (prevIdx <= 0) {
    penTdBeforeClip = true;
    penTouchdown = null;
    if (prevIdx < 0) penTakeoff = null;
  } else if (penTouchdown !== null && penTouchdown <= frames[0]! + 5) {
    penTdBeforeClip = true;
    penTouchdown = null;
  }
  if (penTakeoff !== null && !(penTakeoff < chosen.plantTd)) {
    penTakeoff = null;
  }

  const stepGapMs =
    penTakeoff !== null ? realMs(timing, penTakeoff, chosen.plantTd) : null;

  const reason = penTdBeforeClip
    ? `approach plant TD${chosen.plantTd} TO${chosen.takeoff} LD${chosen.landing}; pen TD started before clip` +
      (penTakeoff !== null ? ` (pen TO${penTakeoff})` : "")
    : `approach plant TD${chosen.plantTd} TO${chosen.takeoff} LD${chosen.landing}` +
      (penTouchdown !== null && penTakeoff !== null
        ? `; pen TD${penTouchdown} TO${penTakeoff}`
        : "");

  return {
    touchdown: chosen.plantTd,
    takeoff: chosen.takeoff,
    landing: chosen.landing,
    penTouchdown,
    penTakeoff,
    penTdBeforeClip,
    plantContactMs: chosen.plantMs,
    flightMs: realMs(timing, chosen.takeoff, chosen.landing),
    stepGapMs,
    reason,
  };
}
