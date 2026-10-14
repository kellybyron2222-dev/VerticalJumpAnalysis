export interface SeekTarget {
  currentTime: number;
  duration: number;
  readyState: number;
  pause(): void;
  addEventListener(type: "seeked", listener: () => void): void;
  removeEventListener(type: "seeked", listener: () => void): void;
}

export function frameCountFor(durationSeconds: number, fps: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(1, Math.round(durationSeconds * fps));
}

export function clampFrame(frame: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  const rounded = Math.round(frame);
  return Math.min(frameCount - 1, Math.max(0, rounded));
}

/**
 * Media time that should display `frame`.
 * A nudge past the frame boundary keeps decoders that snap backward
 * (common on iOS) on this frame instead of the previous one.
 * The time stays inside the frame and inside the media duration.
 */
/**
 * Seek time for a frame on a variable-rate clock. `times` are presentation
 * timestamps. A nudge past the frame start keeps iOS on this frame.
 */
export function frameSeekTimeFromClock(
  times: readonly number[],
  frame: number,
  durationSeconds: number,
): number {
  const start = times[frame] ?? 0;
  const next = frame + 1 < times.length ? times[frame + 1] : start + 1 / 60;
  const gap = Math.max(0.0005, next - start);
  let time = start + gap * 0.15;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    time = Math.min(time, Math.max(0, durationSeconds - gap * 0.05));
  }
  return Math.max(0, time);
}

export function frameSeekTime(frame: number, fps: number, durationSeconds: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  const frameDuration = 1 / fps;
  const nudge = frameDuration * 0.15;
  let time = frame * frameDuration + nudge;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const maxTime = Math.max(0, durationSeconds - frameDuration * 0.05);
    time = Math.min(time, maxTime);
  }
  return Math.max(0, time);
}

/**
 * Serializes seeks and keeps only the newest request.
 * iOS Safari drops currentTime writes that overlap, and it may not fire
 * `seeked` when the time did not change, so each step waits for `seeked`
 * (or a timeout) and identical times resolve immediately.
 */
export class FrameSeeker {
  private queued: number | null = null;
  private running = false;
  private readonly media: SeekTarget;
  private fps: number;
  private times: readonly number[] | null = null;
  private readonly seekTimeoutMs: number;

  constructor(media: SeekTarget, fps: number, seekTimeoutMs = 700) {
    this.media = media;
    this.fps = fps;
    this.seekTimeoutMs = seekTimeoutMs;
  }

  setFps(fps: number): void {
    this.fps = fps;
  }

  /** Presentation time of every real frame. Replaces the uniform fps grid. */
  setClock(times: readonly number[] | null): void {
    this.times = times && times.length > 0 ? times : null;
  }

  get frameCount(): number {
    if (this.times && this.times.length > 0) return this.times.length;
    return frameCountFor(this.media.duration, this.fps);
  }

  request(frame: number): void {
    const count = this.frameCount;
    if (count <= 0) return;
    // A presentation clock can seek without a fps grid; fps is only the fallback.
    if (!this.times && (!Number.isFinite(this.fps) || this.fps <= 0)) return;
    this.queued = clampFrame(frame, count);
    void this.drain();
  }

  /** Seeks to `frame` and resolves once the queue is idle on the newest request. */
  settle(frame: number): Promise<void> {
    this.request(frame);
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private idleWaiters: Array<() => void> = [];

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queued !== null) {
        const frame = this.queued;
        this.queued = null;
        await this.seekOnce(frame);
      }
    } finally {
      this.running = false;
      if (this.queued !== null) void this.drain();
      else {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private seekOnce(frame: number): Promise<void> {
    const media = this.media;
    const time =
      this.times && frame >= 0 && frame < this.times.length
        ? frameSeekTimeFromClock(this.times, frame, media.duration)
        : frameSeekTime(frame, this.fps, media.duration);
    if (media.readyState >= 2 && Math.abs(media.currentTime - time) < 1e-4) {
      return Promise.resolve();
    }

    media.pause();

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
        media.currentTime = time;
      } catch {
        finish();
        return;
      }
      setTimeout(finish, this.seekTimeoutMs);
    });
  }
}
