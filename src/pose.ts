import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  coarseFrames,
  detectAllEvents,
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

/** BlazePose indexes: ankles, heels, foot index (toes), left then right. */
const FOOT_POINTS = [27, 29, 31, 28, 30, 32];
const MIN_VISIBILITY = 0.5;
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

function lowestPoint(landmarks: readonly NormalizedLandmark[], indexes: readonly number[]): number | null {
  let lowest: number | null = null;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < MIN_VISIBILITY) continue;
    if (lowest === null || point.y > lowest) lowest = point.y;
  }
  return lowest;
}

export function footY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  return lowestPoint(landmarks, FOOT_POINTS);
}

/** The higher of the two feet, when both are visible. */
export function upperFootY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  const left = lowestPoint(landmarks, FOOT_POINTS.slice(0, 3));
  const right = lowestPoint(landmarks, FOOT_POINTS.slice(3));
  if (left === null || right === null) return null;
  return Math.min(left, right);
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
    const y = footY(result.landmarks[0]);
    const upper = upperFootY(result.landmarks[0]);
    if (y !== null) {
      samples.push(upper === null ? { frame, footY: y } : { frame, footY: y, upperFootY: upper });
    }
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
  if (!events) return { ok: false, reason: "No jump found." };
  return { ok: true, model: multi.model, events };
}

/**
 * Coarse scan of the whole clip, then refine around each candidate jump.
 * Returns every jump cycle found (1 for a single-jump clip).
 */
export async function analyzeMultiClip(
  options: AnalyzeOptions,
): Promise<MultiDetection & { samples?: FootSample[] }> {
  const { video, seeker, frameCount, onProgress, signal } = options;
  onProgress("Loading pose model…");
  const landmarker = await loadLandmarker();
  const prepared = prepareCanvas(video);
  if (!prepared) return { ok: false, reason: "Canvas is not available." };
  const { canvas, context } = prepared;

  const step = scanStep(frameCount);
  const coarse = coarseFrames(frameCount, step);
  onProgress(`Coarse scan ${coarse.length} frames…`);
  const coarseSamples = await sampleFrames(
    landmarker,
    video,
    seeker,
    coarse,
    canvas,
    context,
    signal,
    onProgress,
    "Coarse",
  );

  const first = detectAllEvents(coarseSamples);
  if (!first.ok) return first;

  const refineSet = new Set<number>();
  for (const jump of first.jumps) {
    for (const frame of refineFrames(jump, Math.max(step, 2), frameCount)) refineSet.add(frame);
  }
  const refineList = [...refineSet].sort((a, b) => a - b);
  onProgress(`Refining ${refineList.length} frames around ${first.jumps.length} jump(s)…`);
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
  const refined = detectAllEvents(merged, { fixedModel: first.model });
  if (!refined.ok) return first;
  return refined;
}

export type { DetectedEvents, GroundModel };
