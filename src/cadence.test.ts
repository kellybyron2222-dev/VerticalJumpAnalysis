import { describe, expect, it } from "vitest";
import { collectFrameTimes, transportEnabledAfterClockRead } from "./cadence.ts";

describe("timestamp read does not block auto-detect", () => {
  it("leaves auto-detect available when no clock was read", () => {
    expect(transportEnabledAfterClockRead(171)).toBe(true);
    expect(transportEnabledAfterClockRead(0)).toBe(false);
  });

  it("returns instead of hanging when play() never settles", async () => {
    const video = fakeVideo();
    const started = Date.now();
    const times = await collectFrameTimes(video, { playTimeoutMs: 40, maxWaitMs: 5000 });
    expect(times).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

function fakeVideo(): HTMLVideoElement {
  const media = {
    duration: 4,
    currentTime: 0,
    playbackRate: 1,
    muted: false,
    readyState: 4,
    pause() {},
    play() {
      return new Promise<void>(() => {});
    },
    requestVideoFrameCallback() {
      return 1;
    },
    cancelVideoFrameCallback() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return media as unknown as HTMLVideoElement;
}
