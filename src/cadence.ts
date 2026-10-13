import { alignClockToDuration, frameClockFromTicks, type FrameTick } from "./timing.ts";

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface CollectOptions {
  /** How long to wait for `play()` before giving up. Safari often never settles it. */
  playTimeoutMs?: number;
  /** Upper bound on the whole read, including a play that hangs. */
  maxWaitMs?: number;
}

/**
 * A failed or skipped timestamp read must not disable stepping or auto-detect.
 * The fps grid is a worse clock, but it still seeks distinct frames.
 */
export function transportEnabledAfterClockRead(frameCount: number): boolean {
  return frameCount > 0;
}

/**
 * Presentation time of each frame. Prefers nothing from playback when the file
 * already supplied a clock; this path is only the fallback. Null when the
 * browser never produces frame callbacks. Always settles: a `play()` that
 * never resolves used to leave the read pending and the controls disabled.
 */
export async function collectFrameTimes(
  video: HTMLVideoElement,
  options: CollectOptions = {},
): Promise<number[] | null> {
  const media = video as FrameCallbackVideo;
  if (typeof media.requestVideoFrameCallback !== "function") return null;

  const previousRate = media.playbackRate;
  try {
    media.muted = true;
    media.playbackRate = 0.5;
    await seekMedia(media, 0);
    const ticks = await collectTicks(media, Number.isFinite(media.duration) ? media.duration : 0, options);
    const times = frameClockFromTicks(ticks);
    if (!times) return null;
    return alignClockToDuration(times, Number.isFinite(media.duration) ? media.duration : 0);
  } catch {
    return null;
  } finally {
    media.pause();
    media.playbackRate = previousRate;
  }
}

function collectTicks(media: FrameCallbackVideo, duration: number, options: CollectOptions): Promise<FrameTick[]> {
  const ticks: FrameTick[] = [];
  const waitMs =
    options.maxWaitMs ?? (duration > 0 ? Math.min(20000, (duration / 0.5) * 1000 + 2500) : 8000);
  const playTimeoutMs = options.playTimeoutMs ?? 1500;
  let handle = 0;
  let settled = false;
  let finish: (value: FrameTick[]) => void = () => {};
  const finished = new Promise<FrameTick[]>((resolve) => {
    finish = resolve;
  });
  let timer = 0;
  let playTimer = 0;
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(playTimer);
    media.removeEventListener("ended", stop);
    media.cancelVideoFrameCallback?.(handle);
    media.pause();
    finish(ticks);
  };
  const onFrame = (_now: number, metadata: FrameMetadata) => {
    if (settled) return;
    ticks.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
    // Compare against the first stamp, not against `duration` itself. Safari may
    // report pre-edit media PTS (about 2s on IMG_0227), which is already past
    // the played duration on the first frame.
    const span = metadata.mediaTime - ticks[0].mediaTime;
    if (duration > 0.05 && ticks.length > 1 && span >= duration - 0.02) stop();
    else handle = media.requestVideoFrameCallback!(onFrame);
  };

  media.addEventListener("ended", stop);
  handle = media.requestVideoFrameCallback!(onFrame);
  timer = globalThis.setTimeout(stop, waitMs);
  // `play()` is raced, not awaited. On iOS it can stay pending after a rate
  // change, and the old code waited on that promise before observing the timeout.
  playTimer = globalThis.setTimeout(() => {
    if (ticks.length === 0) stop();
  }, playTimeoutMs);
  try {
    const played = media.play();
    void Promise.resolve(played)
      .then(() => {
        clearTimeout(playTimer);
      })
      .catch(() => {
        stop();
      });
  } catch {
    stop();
  }
  return finished;
}

function seekMedia(media: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.min(Math.max(0, time), Math.max(0, media.duration - 0.05));
  if (Math.abs(media.currentTime - target) < 0.02) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      media.removeEventListener("seeked", finish);
      resolve();
    };
    media.addEventListener("seeked", finish);
    try {
      media.currentTime = target;
    } catch {
      finish();
      return;
    }
    setTimeout(finish, 700);
  });
}
