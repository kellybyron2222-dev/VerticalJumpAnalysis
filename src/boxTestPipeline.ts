import { analyzeClip } from "./pose.ts";
import { parseMovClip } from "./mov.ts";
import { FrameSeeker } from "./seek.ts";
import { computeTrialMetrics } from "./metrics.ts";
import {
  captureFps,
  measuredFps,
  metricStretch,
  sloMoStretch,
  stepOffForFall,
} from "./timing.ts";
import type { BoxTestHeightSummary } from "./boxTest.ts";

export interface BoxTestRowResult {
  boxHeightIn: number;
  fileName: string;
  fps: number;
  slowMoFactor: number;
  frameTimes: number[];
  stepOff: number | null;
  touchdown: number;
  takeoff: number;
  landing: number;
  gctMs: number;
  heightIn: number;
  rsi: number;
}

function waitForEvent(target: EventTarget, name: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("Video failed to load"));
    };
    const cleanup = () => {
      target.removeEventListener(name, onOk);
      target.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    target.addEventListener(name, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One jump per height summary for the recommender. */
export function summariesFromRowResults(
  rows: readonly Pick<BoxTestRowResult, "boxHeightIn" | "gctMs" | "rsi">[],
): BoxTestHeightSummary[] {
  return [...rows]
    .sort((a, b) => a.boxHeightIn - b.boxHeightIn)
    .map((row) => ({
      boxHeightIn: row.boxHeightIn,
      count: 1,
      meanRsi: row.rsi,
      meanGctMs: row.gctMs,
    }));
}

export function recomputeRowMetrics(
  row: BoxTestRowResult,
  touchdown: number,
  takeoff: number,
  landing: number,
  stepOff: number | null = row.stepOff,
): BoxTestRowResult | null {
  const metrics = computeTrialMetrics({
    touchdown,
    takeoff,
    landing,
    fps: row.fps,
    slowMoFactor: row.slowMoFactor,
    frameTimes: row.frameTimes,
  });
  if (!metrics) return null;
  return {
    ...row,
    stepOff,
    touchdown,
    takeoff,
    landing,
    gctMs: metrics.gctMs,
    heightIn: metrics.heightIn,
    rsi: metrics.rsi,
  };
}

/**
 * Load a clip, read timestamps, auto-detect events, return metrics for one box height.
 * Uses a detached video element so Jump Analysis state is untouched.
 */
export async function processBoxTestClip(
  file: File,
  boxHeightIn: number,
  onProgress: (message: string) => void,
  signal: AbortSignal,
): Promise<BoxTestRowResult> {
  const buffer = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const clip = parseMovClip(new Uint8Array(buffer));
  const times = clip?.times ?? null;
  const hint = { slowMoPlayback: clip?.slowMoPlayback ?? null };

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.preload = "auto";
  const objectUrl = URL.createObjectURL(file);
  try {
    video.src = objectUrl;
    video.load();
    await waitForEvent(video, "loadeddata", signal);

    const playback = times ? measuredFps(times) : null;
    const stretch = times ? sloMoStretch(times, hint) : 1;
    const fps = (times ? captureFps(times, hint) : null) ?? playback ?? 240;
    const factor = metricStretch(times ?? undefined, stretch > 1 ? stretch : 1, hint);
    const seeker = new FrameSeeker(video, fps);
    if (times && times.length >= 3) seeker.setClock(times);
    // Give the element a moment to settle duration on iOS.
    if (!(video.duration > 0)) await waitForEvent(video, "durationchange", signal).catch(() => undefined);
    const frameCount = seeker.frameCount;
    if (frameCount < 3) throw new Error("Not enough frames in this clip.");

    const result = await analyzeClip({
      video,
      seeker,
      frameCount,
      signal,
      onProgress,
    });
    if (!result.ok) throw new Error(result.reason);

    const frameTimes = times ?? [];
    const stepOff = stepOffForFall(
      result.events.stepOff,
      result.events.touchdown,
      frameTimes.length ? frameTimes : undefined,
      factor,
    );
    const metrics = computeTrialMetrics({
      touchdown: result.events.touchdown,
      takeoff: result.events.takeoff,
      landing: result.events.landing,
      fps,
      slowMoFactor: factor,
      frameTimes: frameTimes.length ? frameTimes : undefined,
    });
    if (!metrics) throw new Error("Could not compute metrics from the marks.");

    return {
      boxHeightIn,
      fileName: file.name,
      fps,
      slowMoFactor: factor,
      frameTimes,
      stepOff,
      touchdown: result.events.touchdown,
      takeoff: result.events.takeoff,
      landing: result.events.landing,
      gctMs: metrics.gctMs,
      heightIn: metrics.heightIn,
      rsi: metrics.rsi,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}
