import { GRAVITY_M_S2, metersToCentimeters, metersToInches, realSecondsOnClock } from "./metrics.ts";

export { realSecondsBetween, realSecondsFromMedia, realSecondsOnClock } from "./metrics.ts";

/** Playback factors offered in the UI. 8× is a 240 fps clip stretched to play at 30 fps. */
export const SLOW_MO_FACTORS = [1, 2, 4, 8] as const;

/** Average frames per second across a measured presentation clock. Not a timebase. */
export function measuredFps(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const span = times[times.length - 1] - times[0];
  if (!(span > 0)) return null;
  return (times.length - 1) / span;
}

/** Shortest and longest gap. Photos' single fps is this average, which hides the ramps. */
export function frameGapRange(times: readonly number[]): { shortest: number; longest: number } | null {
  if (times.length < 3) return null;
  let shortest = Number.POSITIVE_INFINITY;
  let longest = 0;
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (!(gap > 0)) continue;
    if (gap < shortest) shortest = gap;
    if (gap > longest) longest = gap;
  }
  if (!Number.isFinite(shortest) || !(longest > 0)) return null;
  return { shortest, longest };
}

/** True when the clip is not one rate — a slowed middle and faster ends, or a 1/60 and 1/30 mix. */
export function isVariableRate(times: readonly number[]): boolean {
  const range = frameGapRange(times);
  if (!range) return false;
  return range.longest > range.shortest * 1.4;
}

export interface SloMoHint {
  /**
   * Apple `full-frame-rate-playback-intent` is 0: the file is meant to play
   * slowed, not at capture rate. Photos still shows the higher capture fps.
   */
  slowMoPlayback?: boolean | null;
}

/**
 * iPhone slo-mo playback holds each captured frame for one or two ticks
 * (about 1/60 s and 1/30 s). The average of those holds is what the file's
 * timestamps measure (~43 fps on IMG_0227). Photos' fps is the capture rate,
 * about four times that average (~170 fps). Real time is the timestamp delta
 * divided by this stretch.
 *
 * Phone Photos exports sometimes flatten the gap pattern; then we still use
 * the Apple slo-mo flag or a playback-rate band (about 28–55 fps).
 */
export function sloMoStretch(times: readonly number[], hint: SloMoHint = {}): number {
  const range = frameGapRange(times);
  if (range) {
    const ratio = range.longest / range.shortest;
    // Classic 1/60 + 1/30 hold pattern (and slight phone-export jitter).
    if (ratio >= 1.5 && ratio <= 2.8 && range.shortest >= 0.01 && range.shortest <= 0.025) return 4;
  }
  const fps = measuredFps(times);
  if (!fps) return 1;
  const appleSloMo = hint.slowMoPlayback === true;
  const looksLikeHeldSloMo = isVariableRate(times) && fps >= 28 && fps <= 55;
  if (!appleSloMo && !looksLikeHeldSloMo) return 1;
  // ~30 fps hold of 240 → 8×; ~40–55 fps hold of ~170–240 → 4×.
  if (fps <= 36) return 8;
  if (fps <= 55) return 4;
  return 1;
}

/** Capture frame rate implied by a playback clock. This is the number to show, not the hold average. */
export function captureFps(times: readonly number[], hint: SloMoHint = {}): number | null {
  const playback = measuredFps(times);
  if (!playback) return null;
  return playback * sloMoStretch(times, hint);
}

/**
 * Stretch used for metrics. A UI factor of 1 must not leave iPhone slo-mo
 * playback timestamps uncorrected — that is exactly the 231 in / 850 ms bug.
 * An explicit user choice (uiFactor !== 1, or uiFactor matching detection) wins.
 */
export function metricStretch(
  frameTimes: readonly number[] | undefined,
  uiFactor: number,
  hint: SloMoHint = {},
): number {
  const detected = frameTimes ? sloMoStretch(frameTimes, hint) : 1;
  if (!(uiFactor > 0)) return detected > 1 ? detected : 1;
  if (detected > 1 && uiFactor === 1) return detected;
  return uiFactor;
}

/**
 * Pose marks step-off once the foot has visibly dropped. A free fall covers
 * the first quarter of its distance in the first half of the time, so the
 * visible gap is about half the real drop. Repeat that gap once, backward.
 */
export function slowFallStepOff(stepOff: number, touchdown: number): number {
  if (!(touchdown > stepOff)) return stepOff;
  return Math.max(0, stepOff - (touchdown - stepOff));
}

/**
 * When pose never sees a clear box stance (step-off 0 / null), place step-off
 * so free fall is about 0.18 s of real time (~6 in). Uses the playback clock
 * and stretch so the seek index matches the video.
 */
export function stepOffForFall(
  stepOff: number | null,
  touchdown: number,
  frameTimes: readonly number[] | undefined,
  stretch: number,
  targetFallSeconds = Math.sqrt((2 * 6 * 0.0254) / 9.80665),
): number | null {
  const visible = stepOff === null ? null : slowFallStepOff(stepOff, touchdown);
  if (!frameTimes || !(stretch > 0) || !(touchdown > 0) || touchdown >= frameTimes.length) {
    return visible;
  }
  const fallOf = (so: number) => {
    const start = Math.min(so + 1, touchdown);
    return (frameTimes[touchdown] - frameTimes[start]) / stretch;
  };
  if (visible !== null && visible > 0) {
    const fall = fallOf(visible);
    if (fall >= 0.11 && fall <= 0.35) return visible;
  }
  const realTouch = frameTimes[touchdown] / stretch;
  const targetStamp = (realTouch - targetFallSeconds) * stretch;
  let best = 0;
  for (let i = 0; i < touchdown; i += 1) {
    if (frameTimes[i] <= targetStamp) best = i;
  }
  return best;
}

/**
 * Strictly increasing presentation times from frame callbacks.
 * Repeated callbacks for one frame (same mediaTime) are dropped.
 */
export function frameClockFromTicks(ticks: readonly FrameTick[]): number[] | null {
  const times: number[] = [];
  for (const tick of ticks) {
    const time = tick.mediaTime;
    if (!(time >= 0) || !Number.isFinite(time)) continue;
    const rounded = Math.round(time * 1e6) / 1e6;
    const prev = times.length > 0 ? times[times.length - 1] : -1;
    if (rounded > prev + 0.0004) times.push(rounded);
  }
  return times.length >= 3 ? times : null;
}

/**
 * Safari can report `mediaTime` in the media timescale, including the pre-edit
 * offset, so the stamps sit past `duration` and every seek clamps to the last
 * frame. Shift that clock onto the played duration. Differences are unchanged,
 * which is what the metrics use. Stamps already inside the duration stay put.
 */
export function alignClockToDuration(times: readonly number[], duration: number): number[] | null {
  const clock = frameClockFromTicks(times.map((mediaTime, presentedFrames) => ({ mediaTime, presentedFrames })));
  if (!clock) return null;
  if (!(duration > 0)) return clock;
  const first = clock[0];
  const last = clock[clock.length - 1];
  if (first >= -0.02 && last <= duration + 0.05) return clock;
  const span = last - first;
  if (first > 0.05 && span > 0 && span <= duration * 1.25) {
    return clock.map((time) => Math.round((time - first) * 1e6) / 1e6);
  }
  return clock;
}

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

/** captureFps / slowMoFactor. The scrubber stays on capture fps; metrics do not use this. */
export function mediaFrameRate(captureFps: number, slowMoFactor: number): number {
  if (!(captureFps > 0) || !(slowMoFactor > 0)) return 0;
  return captureFps / slowMoFactor;
}

/**
 * Frame rate of the faster window, snapped to a capture rate iPhones actually
 * shoot. A fully stretched 30 fps file does not reveal capture rate; returns null.
 */
export function snapCaptureFps(clipFps: number): number | null {
  if (!(clipFps > 0)) return null;
  for (const rate of [240, 120, 60]) {
    if (Math.abs(clipFps - rate) / rate <= 0.15) return rate;
  }
  return null;
}

/**
 * Slow-mo lives in the middle of an iPhone clip; the opening is often real time.
 * Each interval is already a low quantile, so the longer one is the slow region
 * rather than a dropped display frame.
 */
export function cadenceFromIntervals(
  intervals: readonly (number | null)[],
): { slowFps: number; fastFps: number } | null {
  const good = intervals.filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  if (good.length === 0) return null;
  return { slowFps: 1 / Math.max(...good), fastFps: 1 / Math.min(...good) };
}

/** Keeps a frame on the same video moment when the seek grid changes. */
export function rescaleFrame(frame: number, fromFactor: number, toFactor: number): number {
  if (!(fromFactor > 0) || !(toFactor > 0)) return frame;
  return Math.max(0, Math.round((frame * fromFactor) / toFactor));
}

/**
 * Plain-language warnings for numbers that are physically unlikely.
 * `boxHeightIn` is the video estimate. A uniform stretch scales both heights
 * the same way; a ramp (slow only in the middle) makes them disagree.
 */
export function sanityWarnings(input: {
  heightIn: number | null;
  gctMs: number | null;
  boxHeightIn?: number | null;
  /** Free-fall time from the frame timestamps, in seconds. */
  fallSeconds?: number | null;
}): string[] {
  const warnings: string[] = [];
  if (input.heightIn !== null) {
    if (input.heightIn > 40) warnings.push("Jump height is over 40 in.");
    else if (input.heightIn < 2) warnings.push("Jump height is under 2 in.");
  }
  if (input.gctMs !== null && (input.gctMs < 80 || input.gctMs > 1000)) {
    warnings.push("Contact time is outside 80–1000 ms.");
  }
  // ~2.5 in to ~40 in of free fall. A single average fps (Photos' 171) misses this.
  if (input.fallSeconds != null && (input.fallSeconds < 0.11 || input.fallSeconds > 0.45)) {
    warnings.push("Free-fall time does not match a real box.");
  }
  const box = input.boxHeightIn ?? null;
  if (
    box !== null &&
    input.heightIn !== null &&
    box >= 2 &&
    input.heightIn >= 2 &&
    (input.heightIn > box * 6 || box > input.heightIn * 8)
  ) {
    warnings.push(
      "Jump height and the box-height estimate disagree, so the drop and the flight may be on different slow-mo speeds.",
    );
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
export function estimateBoxHeight(
  stepOff: number,
  touchdown: number,
  captureFps: number,
  slowMoFactor = 1,
  frameTimes?: readonly number[],
): BoxEstimate | null {
  if (!frameTimes && !(captureFps > 0)) return null;
  if (!Number.isInteger(stepOff) || !Number.isInteger(touchdown) || stepOff < 0) return null;
  const fallSeconds = realSecondsOnClock(frameTimes, stepOff + 1, touchdown, captureFps, slowMoFactor);
  if (!(fallSeconds > 0)) return null;
  const heightM = (GRAVITY_M_S2 * fallSeconds * fallSeconds) / 2;
  return {
    fallSeconds,
    heightM,
    heightIn: metersToInches(heightM),
    heightCm: metersToCentimeters(heightM),
  };
}
