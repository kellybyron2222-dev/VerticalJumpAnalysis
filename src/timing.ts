import { GRAVITY_M_S2, metersToCentimeters, metersToInches } from "./metrics.ts";

/** Playback factors offered in the UI. 8× is a 240 fps clip stretched to play at 30 fps. */
export const SLOW_MO_FACTORS = [1, 4, 8] as const;

/** One `requestVideoFrameCallback` reading while the clip plays. */
export interface FrameTick {
  mediaTime: number;
  presentedFrames: number;
}

/**
 * Seconds of media time per encoded frame, from frame callbacks.
 * Dropped display frames make some gaps a multiple of the true interval,
 * so a low quantile of the per-frame gaps is used rather than the mean.
 */
export function estimateFrameInterval(ticks: readonly FrameTick[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const dt = ticks[i].mediaTime - ticks[i - 1].mediaTime;
    const frames = ticks[i].presentedFrames - ticks[i - 1].presentedFrames;
    if (!(dt > 0) || !(frames >= 1)) continue;
    gaps.push(frames === 1 ? dt : dt / frames);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor((gaps.length - 1) * 0.25)];
}

/**
 * Media seconds per real second, from the capture rate and the rate the
 * clip actually plays at. Snaps to 1/2/4/8 when within 15%, never below 1.
 */
export function slowMoFactorFor(captureFps: number, clipFps: number): number {
  if (!(captureFps > 0) || !(clipFps > 0)) return 1;
  const ratio = captureFps / clipFps;
  for (const snap of [1, 2, 4, 8]) {
    if (Math.abs(ratio - snap) / snap <= 0.15) return snap;
  }
  return Math.max(1, Math.round(ratio * 10) / 10);
}

/**
 * Frames per media second on the capture grid. Frame indexes always count
 * real captured frames, so `frame / captureFps` is real seconds.
 */
export function mediaFrameRate(captureFps: number, slowMoFactor: number): number {
  if (!(captureFps > 0) || !(slowMoFactor > 0)) return 0;
  return captureFps / slowMoFactor;
}

export function realSecondsFromMedia(mediaSeconds: number, slowMoFactor: number): number {
  return slowMoFactor > 0 ? mediaSeconds / slowMoFactor : mediaSeconds;
}

/** Keeps a frame on the same video moment when the slow-mo factor changes. */
export function rescaleFrame(frame: number, fromFactor: number, toFactor: number): number {
  if (!(fromFactor > 0) || !(toFactor > 0)) return frame;
  return Math.max(0, Math.round((frame * fromFactor) / toFactor));
}

/** Plain-language warnings for numbers that are physically unlikely. */
export function sanityWarnings(input: { heightIn: number | null; gctMs: number | null }): string[] {
  const warnings: string[] = [];
  if (input.heightIn !== null) {
    if (input.heightIn > 40) warnings.push("Jump height is over 40 in.");
    else if (input.heightIn < 2) warnings.push("Jump height is under 2 in.");
  }
  if (input.gctMs !== null && (input.gctMs < 80 || input.gctMs > 1000)) {
    warnings.push("Contact time is outside 80–1000 ms.");
  }
  return warnings;
}

export interface BoxEstimate {
  fallSeconds: number;
  heightM: number;
  heightIn: number;
  heightCm: number;
}

/**
 * Box height from free fall: `h = g × t² / 2`. `stepOff` is the last frame
 * on the box and `touchdown` the first frame on the floor, so the airborne
 * frames are `stepOff + 1 … touchdown − 1`, counted the same way as flight time.
 */
export function estimateBoxHeight(stepOff: number, touchdown: number, captureFps: number): BoxEstimate | null {
  if (!(captureFps > 0)) return null;
  if (!Number.isInteger(stepOff) || !Number.isInteger(touchdown) || stepOff < 0) return null;
  const airFrames = touchdown - (stepOff + 1);
  if (airFrames <= 0) return null;
  const fallSeconds = airFrames / captureFps;
  const heightM = (GRAVITY_M_S2 * fallSeconds * fallSeconds) / 2;
  return {
    fallSeconds,
    heightM,
    heightIn: metersToInches(heightM),
    heightCm: metersToCentimeters(heightM),
  };
}
