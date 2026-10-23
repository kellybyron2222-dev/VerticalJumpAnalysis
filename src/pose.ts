import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  coarseFrames,
  detectAllEvents,
  detectEvents,
  refineFrames,
  type DetectedEvents,
  type Detection,
  type FootSample,
  type GroundModel,
  type MultiDetection,
} from "./detect.ts";
import { scanStep } from "./multiJump.ts";
import type { FrameSeeker } from "./seek.ts";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";

/** Ankles + heels only — skip foot-index (toes); dark shoes often hide them. */
const ANKLE_HEEL = [27, 29, 28, 30];
const LEFT_ANKLE_HEEL = [27, 29];
const RIGHT_ANKLE_HEEL = [28, 30];
const KNEES = [25, 26];
const HIPS = [23, 24];
/** Low bar so black shoes / busy backgrounds still yield a trajectory. */
const MIN_VISIBILITY = 0.18;
const MIN_VISIBILITY_PROXY = 0.12;
/** Longest edge of the frame passed to the model; fixed so runs are identical. */
const INPUT_EDGE = 512;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/**
 * IMAGE mode on CPU: each frame is scored on its own with no tracking state,
 * so the same frame gives the same landmarks regardless of visit order.
 */
function loadLandmarker(): Promise<PoseLandmarker> {
  landmarkerPromise ??= FilesetResolver.forVisionTasks(WASM_URL).then((fileset) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "IMAGE",
      numPoses: 1,
    }),
  );
  landmarkerPromise.catch(() => {
    landmarkerPromise = null;
  });
  return landmarkerPromise;
}

function lowestPoint(
  landmarks: readonly NormalizedLandmark[],
  indexes: readonly number[],
  minVisibility: number,
): number | null {
  let lowest: number | null = null;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < minVisibility) continue;
    if (lowest === null || point.y > lowest) lowest = point.y;
  }
  return lowest;
}

function meanPoint(
  landmarks: readonly NormalizedLandmark[],
  indexes: readonly number[],
  minVisibility: number,
): number | null {
  let sum = 0;
  let n = 0;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < minVisibility) continue;
    sum += point.y;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

export function footY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  return lowestPoint(landmarks, ANKLE_HEEL, MIN_VISIBILITY);
}

/** The higher of the two feet (ankle/heel), when both sides are visible. */
export function upperFootY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  const left = lowestPoint(landmarks, LEFT_ANKLE_HEEL, MIN_VISIBILITY);
  const right = lowestPoint(landmarks, RIGHT_ANKLE_HEEL, MIN_VISIBILITY);
  if (left === null || right === null) return null;
  return Math.min(left, right);
}

/**
 * Contact / body-height signal for event detection. Prefers ankle/heel, then
 * knee, then hip (larger Y = lower in the frame). Hip alone still tracks the
 * drop and rebound when feet are invisible on a black floor.
 */
export function sampleFromLandmarks(
  landmarks: readonly NormalizedLandmark[] | undefined,
  frame: number,
): FootSample | null {
  if (!landmarks?.length) return null;
  const feet = lowestPoint(landmarks, ANKLE_HEEL, MIN_VISIBILITY);
  const knees = lowestPoint(landmarks, KNEES, MIN_VISIBILITY_PROXY);
  const hip = meanPoint(landmarks, HIPS, MIN_VISIBILITY_PROXY);
  const upper = upperFootY(landmarks);

  let contact: number | null = feet;
  if (contact === null && knees !== null) contact = knees;
  // Hip is higher in the frame; bias downward so ground quantiles stay usable.
  if (contact === null && hip !== null) contact = Math.min(0.98, hip + 0.28);
  if (contact === null) return null;

  const sample: FootSample = { frame, footY: contact };
  if (upper !== null) sample.upperFootY = upper;
  if (hip !== null) sample.hipY = hip;
  return sample;
}

export interface AnalyzeOptions {
  video: HTMLVideoElement;
  seeker: FrameSeeker;
  frameCount: number;
  onProgress: (message: string) => void;
  signal: AbortSignal;
}

async function sampleFrames(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  seeker: FrameSeeker,
  frames: readonly number[],
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  label: string,
): Promise<FootSample[]> {
  const samples: FootSample[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const frame = frames[i]!;
    await seeker.settle(frame);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = landmarker.detect(canvas);
    const sample = sampleFromLandmarks(result.landmarks[0], frame);
    if (sample) samples.push(sample);
    if (i % 8 === 0) onProgress(`${label} ${i + 1} / ${frames.length}`);
  }
  return samples;
}

function prepareCanvas(video: HTMLVideoElement): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} | null {
  const scale = Math.min(1, INPUT_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  return { canvas, context };
}

export async function analyzeClip(options: AnalyzeOptions): Promise<Detection> {
  const multi = await analyzeMultiClip(options);
  if (!multi.ok) return multi;
  const events = multi.jumps[0];
  if (!events) {
    return {
      ok: false,
      reason: "No jump found. Mark touchdown, takeoff, and landing by hand.",
    };
  }
  return { ok: true, model: multi.model, events };
}

/**
 * Scan the clip (coarse then refine). Always runs the classic single-jump
 * detector; multi-jump UI only when 2+ clear cycles are found.
 */
export async function analyzeMultiClip(
  options: AnalyzeOptions,
): Promise<MultiDetection & { samples?: FootSample[] }> {
  const { video, seeker, frameCount, onProgress, signal } = options;
  onProgress("Loading pose model…");
  const landmarker = await loadLandmarker();
  const prepared = prepareCanvas(video);
  if (!prepared) return { ok: false, reason: "Canvas is not available. Mark events by hand." };
  const { canvas, context } = prepared;

  // Short single-jump clips stay at full rate; long clips coarse-scan first.
  const step = frameCount <= 800 ? 1 : scanStep(frameCount);
  const coarse = coarseFrames(frameCount, step);
  onProgress(`Scanning ${coarse.length} frames…`);
  const coarseSamples = await sampleFrames(
    landmarker,
    video,
    seeker,
    coarse,
    canvas,
    context,
    signal,
    onProgress,
    "Scan",
  );

  if (coarseSamples.length < 8) {
    return {
      ok: false,
      reason:
        "Pose saw too few body landmarks (dark shoes or busy background). Mark touchdown, takeoff, and landing by hand.",
    };
  }

  // Prefer classic single-jump path (handles mid-drop starts at frame 0).
  let single = detectEvents(coarseSamples);
  const refineTargets: DetectedEvents[] = [];
  if (single.ok) refineTargets.push(single.events);
  const multiCoarse = detectAllEvents(coarseSamples, { maxJumps: 8 });
  if (multiCoarse.ok && multiCoarse.jumps.length >= 2) {
    for (const jump of multiCoarse.jumps) refineTargets.push(jump);
  }

  if (refineTargets.length === 0) {
    return {
      ok: false,
      reason:
        single.ok === false
          ? `${single.reason}`
          : "No jump found. Mark touchdown, takeoff, and landing by hand.",
    };
  }

  const refineSet = new Set<number>();
  for (const jump of refineTargets) {
    for (const frame of refineFrames(jump, Math.max(step, 2), frameCount)) refineSet.add(frame);
  }
  const refineList = [...refineSet].sort((a, b) => a - b);
  onProgress(`Refining ${refineList.length} frames…`);
  const fineSamples = await sampleFrames(
    landmarker,
    video,
    seeker,
    refineList,
    canvas,
    context,
    signal,
    onProgress,
    "Refine",
  );

  const merged = [...coarseSamples, ...fineSamples];
  single = detectEvents(merged, single.ok ? single.model : undefined);
  const multi = detectAllEvents(merged, {
    fixedModel: multiCoarse.ok ? multiCoarse.model : single.ok ? single.model : undefined,
    maxJumps: 8,
  });

  // Multi-jump only when 2+ clear cycles; otherwise keep the single-jump path.
  if (multi.ok && multi.jumps.length >= 2) return multi;
  if (single.ok) return { ok: true, jumps: [single.events], model: single.model };
  if (multi.ok && multi.jumps.length === 1) {
    return { ok: true, jumps: multi.jumps, model: multi.model };
  }
  return {
    ok: false,
    reason:
      (single.ok ? null : single.reason) ??
      "Auto-detect could not find a jump. Mark touchdown, takeoff, and landing by hand.",
  };
}

export type { DetectedEvents, GroundModel };
