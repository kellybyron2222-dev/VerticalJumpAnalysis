import { describe, expect, it, vi } from "vitest";
import { FrameSeeker, clampFrame, frameCountFor, frameSeekTime, type SeekTarget } from "./seek.ts";

class FakeMedia implements SeekTarget {
  duration = 1;
  readyState = 2;
  paused = true;
  sets: number[] = [];
  events: string[] = [];
  maxInFlight = 0;
  private time = 0;
  private inFlight = 0;
  private listeners = new Set<() => void>();

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.sets.push(value);
    this.events.push("time");
  }

  pause(): void {
    this.paused = true;
    this.events.push("pause");
  }

  addEventListener(_type: "seeked", listener: () => void): void {
    this.listeners.add(listener);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
  }

  removeEventListener(_type: "seeked", listener: () => void): void {
    if (!this.listeners.delete(listener)) return;
    this.inFlight -= 1;
  }

  fireSeeked(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("frame timing", () => {
  it("counts frames from duration and fps", () => {
    expect(frameCountFor(1, 240)).toBe(240);
    expect(frameCountFor(0, 240)).toBe(0);
    expect(frameCountFor(Number.NaN, 240)).toBe(0);
    expect(frameCountFor(1, 0)).toBe(0);
    expect(frameCountFor(1 / 240, 240)).toBe(1);
  });

  it("clamps the playhead to the clip", () => {
    expect(clampFrame(-4, 240)).toBe(0);
    expect(clampFrame(239.2, 240)).toBe(239);
    expect(clampFrame(500, 240)).toBe(239);
    expect(clampFrame(3, 0)).toBe(0);
  });

  it("nudges into the frame and stays inside the media", () => {
    const fps = 240;
    const duration = 1;
    const early = frameSeekTime(0, fps, duration);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(1 / fps);

    const mid = frameSeekTime(10, fps, duration);
    expect(mid).toBeGreaterThan(10 / fps);
    expect(mid).toBeLessThan(11 / fps);

    const last = frameCountFor(duration, fps) - 1;
    const end = frameSeekTime(last, fps, duration);
    expect(end).toBeGreaterThan(last / fps);
    expect(end).toBeLessThan(duration);
    expect(end).toBeLessThan((last + 1) / fps);
  });

  it("keeps the last frame inside a clip that ends mid-frame", () => {
    const fps = 240;
    const duration = 100.5 / fps;
    const last = frameCountFor(duration, fps) - 1;
    const time = frameSeekTime(last, fps, duration);
    expect(time).toBeGreaterThanOrEqual(last / fps);
    expect(time).toBeLessThan(duration);
  });
});

describe("FrameSeeker", () => {
  it("pauses, then seeks, and waits for seeked before the next write", async () => {
    const media = new FakeMedia();
    const seeker = new FrameSeeker(media, 240, 700);

    seeker.request(1);
    expect(media.sets).toHaveLength(1);
    expect(media.events.slice(0, 2)).toEqual(["pause", "time"]);
    expect(media.maxInFlight).toBe(1);

    seeker.request(2);
    seeker.request(5);
    expect(media.sets).toHaveLength(1);

    media.fireSeeked();
    await flush();
    expect(media.sets).toHaveLength(2);
    expect(media.sets[1]).toBeCloseTo(frameSeekTime(5, 240, 1), 10);
    expect(media.maxInFlight).toBe(1);

    media.fireSeeked();
    await flush();
    expect(media.sets).toHaveLength(2);
  });

  it("does not hang when the target time is already showing", async () => {
    const media = new FakeMedia();
    const seeker = new FrameSeeker(media, 240, 50);
    media.currentTime = frameSeekTime(0, 240, 1);
    media.sets.length = 0;
    media.events.length = 0;

    seeker.request(0);
    await flush();
    expect(media.sets).toHaveLength(0);
    expect(media.events).not.toContain("pause");

    seeker.request(4);
    expect(media.sets).toHaveLength(1);
  });

  it("moves on if seeked never arrives", async () => {
    vi.useFakeTimers();
    try {
      const media = new FakeMedia();
      const seeker = new FrameSeeker(media, 240, 700);
      seeker.request(3);
      expect(media.sets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(700);
      seeker.request(8);
      expect(media.sets).toHaveLength(2);
      expect(media.sets[1]).toBeCloseTo(frameSeekTime(8, 240, 1), 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settle resolves only after the frame's seeked event", async () => {
    const media = new FakeMedia();
    const seeker = new FrameSeeker(media, 240, 700);
    let done = false;
    const settled = seeker.settle(6).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    media.fireSeeked();
    await settled;
    expect(media.currentTime).toBeCloseTo(frameSeekTime(6, 240, 1), 10);
  });

  it("ignores seeks before the duration is known", () => {
    const media = new FakeMedia();
    media.duration = Number.NaN;
    const seeker = new FrameSeeker(media, 240);
    seeker.request(4);
    expect(media.sets).toHaveLength(0);
  });
});
