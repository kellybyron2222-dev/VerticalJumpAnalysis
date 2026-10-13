import { frameClockFromTicks, type FrameTick } from "./timing.ts";

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Presentation time of each frame, from playing the clip once.
 * iPhone slo-mo files are variable-rate, so this list — not a fixed fps —
 * is the clock. Null when the browser has no frame callbacks.
 */
export async function collectFrameTimes(video: HTMLVideoElement): Promise<number[] | null> {
  const media = video as FrameCallbackVideo;
  if (typeof media.requestVideoFrameCallback !== "function") return null;

  const previousRate = media.playbackRate;
  try {
    media.muted = true;
    media.playbackRate = 0.5;
    await seekMedia(media, 0);
    const ticks = await collectTicks(media, Number.isFinite(media.duration) ? media.duration : 0);
    return frameClockFromTicks(ticks);
  } catch {
    return null;
  } finally {
    media.pause();
    media.playbackRate = previousRate;
  }
}

function collectTicks(media: FrameCallbackVideo, duration: number): Promise<FrameTick[]> {
  const ticks: FrameTick[] = [];
  const limit = duration > 0.05 ? duration - 0.02 : Number.POSITIVE_INFINITY;
  const waitMs = duration > 0 ? Math.min(20000, (duration / 0.5) * 1000 + 2500) : 8000;
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
    media.removeEventListener("ended", stop);
    media.cancelVideoFrameCallback?.(handle);
    finish();
  };
  const onFrame = (_now: number, metadata: FrameMetadata) => {
    if (settled) return;
    ticks.push({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
    if (metadata.mediaTime >= limit) stop();
    else handle = media.requestVideoFrameCallback!(onFrame);
  };

  media.addEventListener("ended", stop);
  handle = media.requestVideoFrameCallback!(onFrame);
  timer = window.setTimeout(stop, waitMs);
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
