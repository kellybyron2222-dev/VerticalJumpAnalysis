/** Standard gravity. One constant for every height and RSI calculation. */
export const GRAVITY_M_S2 = 9.80665;

/** International inch. */
export const METERS_PER_INCH = 0.0254;

export interface MarkFrames {
  touchdown: number;
  takeoff: number;
  landing: number;
  fps: number;
  /** Media seconds per real second. Omitted means real time (1). */
  slowMoFactor?: number;
}

export interface TrialMetrics {
  gctSeconds: number;
  gctMs: number;
  flightSeconds: number;
  flightMs: number;
  heightM: number;
  heightCm: number;
  heightIn: number;
  rsi: number;
}

export interface MetricsPreview {
  gctMs: number | null;
  flightMs: number | null;
  heightIn: number | null;
  heightCm: number | null;
  rsi: number | null;
  /** Null when the three marks are valid and every metric is filled in. */
  message: string | null;
}

export function jumpHeightMeters(flightTimeSeconds: number): number {
  return (GRAVITY_M_S2 * flightTimeSeconds * flightTimeSeconds) / 8;
}

/**
 * Media seconds → real seconds. `slowMoFactor` is media seconds per real
 * second (8 when a 240 fps capture plays back at 30 fps).
 */
export function realSecondsFromMedia(mediaSeconds: number, slowMoFactor: number): number {
  return slowMoFactor > 0 ? mediaSeconds / slowMoFactor : mediaSeconds;
}

/**
 * Real seconds between two frames. Frame indexes sit on the capture-fps
 * media grid (the scrubber). Every contact, flight, height, RSI, and box
 * duration goes through here, so a slow-mo factor cannot be applied to
 * one metric and skipped on another.
 */
export function realSecondsBetween(
  startFrame: number,
  endFrame: number,
  captureFps: number,
  slowMoFactor = 1,
): number {
  if (!(captureFps > 0)) return Number.NaN;
  return realSecondsFromMedia((endFrame - startFrame) / captureFps, slowMoFactor);
}

export function metersToInches(meters: number): number {
  return meters / METERS_PER_INCH;
}

export function metersToCentimeters(meters: number): number {
  return meters * 100;
}

function validFps(fps: number): boolean {
  return Number.isFinite(fps) && fps > 0;
}

function validFrame(frame: number): boolean {
  return Number.isInteger(frame) && frame >= 0;
}

/**
 * GCT, flight time, height, and RSI from frame indexes.
 * Returns null unless touchdown < takeoff < landing and fps is positive.
 */
export function computeTrialMetrics(input: MarkFrames): TrialMetrics | null {
  const { touchdown, takeoff, landing, fps } = input;
  if (!validFps(fps)) return null;
  if (!validFrame(touchdown) || !validFrame(takeoff) || !validFrame(landing)) return null;
  if (!(touchdown < takeoff && takeoff < landing)) return null;

  const factor = input.slowMoFactor ?? 1;
  const gctSeconds = realSecondsBetween(touchdown, takeoff, fps, factor);
  const flightSeconds = realSecondsBetween(takeoff, landing, fps, factor);
  const heightM = jumpHeightMeters(flightSeconds);

  return {
    gctSeconds,
    gctMs: gctSeconds * 1000,
    flightSeconds,
    flightMs: flightSeconds * 1000,
    heightM,
    heightCm: metersToCentimeters(heightM),
    heightIn: metersToInches(heightM),
    rsi: heightM / gctSeconds,
  };
}

/**
 * Live readout while the user is still marking. Partial GCT or flight time
 * shows as soon as that pair is in order. All three marks out of order
 * produce no numbers.
 */
export function previewMetrics(input: {
  touchdown: number | null;
  takeoff: number | null;
  landing: number | null;
  fps: number;
  slowMoFactor?: number;
}): MetricsPreview {
  const blank: MetricsPreview = {
    gctMs: null,
    flightMs: null,
    heightIn: null,
    heightCm: null,
    rsi: null,
    message: null,
  };

  if (!validFps(input.fps)) {
    return { ...blank, message: "Enter a frame rate above 0." };
  }

  const { touchdown, takeoff, landing, fps } = input;
  const factor = input.slowMoFactor ?? 1;
  if (touchdown !== null && takeoff !== null && landing !== null) {
    const metrics = computeTrialMetrics({ touchdown, takeoff, landing, fps, slowMoFactor: factor });
    if (!metrics) {
      return {
        ...blank,
        message: "Touchdown, takeoff, and landing have to be in that order.",
      };
    }
    return {
      gctMs: metrics.gctMs,
      flightMs: metrics.flightMs,
      heightIn: metrics.heightIn,
      heightCm: metrics.heightCm,
      rsi: metrics.rsi,
      message: null,
    };
  }

  const preview: MetricsPreview = {
    ...blank,
    message: "Mark touchdown, takeoff, and landing.",
  };

  if (touchdown !== null && takeoff !== null && validFrame(touchdown) && validFrame(takeoff) && takeoff > touchdown) {
    preview.gctMs = realSecondsBetween(touchdown, takeoff, fps, factor) * 1000;
  }

  if (takeoff !== null && landing !== null && validFrame(takeoff) && validFrame(landing) && landing > takeoff) {
    const flightSeconds = realSecondsBetween(takeoff, landing, fps, factor);
    const heightM = jumpHeightMeters(flightSeconds);
    preview.flightMs = flightSeconds * 1000;
    preview.heightCm = metersToCentimeters(heightM);
    preview.heightIn = metersToInches(heightM);
  }

  return preview;
}
