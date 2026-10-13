import { cadenceFromIntervals, estimateFrameInterval, type FrameTick } from "./timing.ts";

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const MAX_TICKS = 16;
const MAX_WAIT_MS = 1200;
/** Slow enough that a 240 fps clip still presents each frame on a 60 Hz screen. */
const PROBE_RATE = 0.2;

export interface ClipCadence {
  /** Frames per media second in the slower window (the jump, in the middle). */
  slowFps: number;
  /** Frames per media second in the faster window (often the real-time opening). */
  fastFps: number;
}

/**
 * Frame rate at the start and in the middle. iPhone slo-mo ramps: the opening
 * is often real time and only the middle is slow, so the opening alone reports 1×.
 * Null when the browser has no frame callbacks or playback is blocked.
 */
export async function measureClipCadence(video: HTMLVideoElement): Promise<ClipCadence | null> {
  const media = video as FrameCallbackVideo;
  if (typeof media.requestVideoFrameCallback !== "function") return null;

  const previousRate = media.playbackRate;
  try {
    media.muted = true;
    media.playbackRate = PROBE_RATE;
    const start = await collectTicks(media);
    let middle: FrameTick[] = [];
    if (Number.isFinite(media.duration) && media.duration > 0.4) {
      media.pause();
      await seekMedia(media, media.duration * 0.5);
      middle = await collectTicks(media);
    }
    return cadenceFromIntervals([estimateFrameInterval(start), estimateFrameInterval(middle)]);
  } catch {
    return null;
  } finally {
    media.pause();
    media.playbackRate = previousRate;
  }
}

function collectTicks(media: FrameCallbackVideo): Promise<FrameTick[]> {
  const ticks: FrameTick[] = [];
  let handle = 0;
  let settled = false;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let timer = 0;
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    media.cancelVideoFrameCallback?.(handle);
    finish();
  };
  const onFrame = (_now: number, metadata: FrameMetadata) => {
    if (settled) return;
    ticks.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
    if (ticks.length >= MAX_TICKS) stop();
    else handle = media.requestVideoFrameCallback!(onFrame);
  };

  handle = media.requestVideoFrameCallback!(onFrame);
  timer = window.setTimeout(stop, MAX_WAIT_MS);
  return media
    .play()
    .then(() => finished)
    .then(() => ticks)
    .catch(() => {
      stop();
      return ticks;
    });
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
