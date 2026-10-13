import { estimateFrameInterval, type FrameTick } from "./timing.ts";

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const MAX_TICKS = 40;
const MAX_WAIT_MS = 2500;
/** Slow enough that a 240 fps clip still presents each frame on a 60 Hz screen. */
const PROBE_RATE = 0.2;

/**
 * Frames per media second the clip actually contains, read by playing it
 * slowly and watching `requestVideoFrameCallback`. Null when the browser
 * has no frame callbacks or playback is blocked.
 */
export async function measureClipFps(video: HTMLVideoElement): Promise<number | null> {
  const media = video as FrameCallbackVideo;
  if (typeof media.requestVideoFrameCallback !== "function") return null;

  const ticks: FrameTick[] = [];
  const previousRate = media.playbackRate;
  let handle = 0;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const onFrame = (_now: number, metadata: FrameMetadata) => {
    ticks.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
    if (ticks.length >= MAX_TICKS) done();
    else handle = media.requestVideoFrameCallback!(onFrame);
  };

  handle = media.requestVideoFrameCallback(onFrame);
  const timer = setTimeout(done, MAX_WAIT_MS);
  try {
    media.muted = true;
    media.playbackRate = PROBE_RATE;
    await media.play();
    await finished;
  } catch {
    // Blocked playback leaves too few ticks; the caller falls back to manual.
  } finally {
    clearTimeout(timer);
    media.cancelVideoFrameCallback?.(handle);
    media.pause();
    media.playbackRate = previousRate;
  }

  const interval = estimateFrameInterval(ticks);
  return interval === null ? null : 1 / interval;
}
