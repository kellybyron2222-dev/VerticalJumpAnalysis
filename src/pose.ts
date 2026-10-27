import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  coarseFrames,
  detectAllEvents,
  detectEvents,
  groundModel,
  refineFrames,
  type DetectedEvents,
  type Detection,
  type FootSample,
  type GroundModel,
  type MultiDetection,
} from "./detect.ts";
import { emptyDiagnostics, median, type DetectDiagnostics } from "./detectDiag.ts";
import { scanStep } from "./multiJump.ts";
import type { JumpCountChoice } from "./jumpCountPref.ts";
import { resolveJumpSet, type JumpTimingContext } from "./resolveJumps.ts";
import type { FrameSeeker } from "./seek.ts";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm";

/** Default lite; heavy only when High accuracy is on (lazy-loaded). */
export type PoseModelQuality = "lite" | "heavy";

const MODEL_URLS: Record<PoseModelQuality, string> = {
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
  heavy:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
};

const ANKLE_HEEL = [27, 29, 28, 30];
const LEFT_ANKLE_HEEL = [27, 29];
const RIGHT_ANKLE_HEEL = [28, 30];
const ANKLES = [27, 28];
const HEELS = [29, 30];
const KNEES = [25, 26];
const HIPS = [23, 24];
/** Very low so black shoes / busy gym backgrounds still yield a track. */
const MIN_VISIBILITY = 0.08;
const MIN_VISIBILITY_PROXY = 0.05;
/** Long-side decode cap before MediaPipe (desktop speed; landmarks stay normalized). */
const INPUT_EDGE = 480;

const landmarkerByQuality = new Map<PoseModelQuality, Promise<PoseLandmarker>>();

function loadLandmarker(quality: PoseModelQuality = "lite"): Promise<PoseLandmarker> {
  let pending = landmarkerByQuality.get(quality);
  if (!pending) {
    pending = FilesetResolver.forVisionTasks(WASM_URL).then((fileset) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URLS[quality], delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 2,
      }),
    );
    pending.catch(() => {
      landmarkerByQuality.delete(quality);
    });
    landmarkerByQuality.set(quality, pending);
  }
  return pending;
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

function lowestPointXY(
  landmarks: readonly NormalizedLandmark[],
  indexes: readonly number[],
  minVisibility: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < minVisibility) continue;
    if (!best || point.y > best.y) best = { x: point.x, y: point.y };
  }
  return best;
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

function meanVisibility(
  landmarks: readonly NormalizedLandmark[],
  indexes: readonly number[],
): number | null {
  let sum = 0;
  let n = 0;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || point.visibility === undefined) continue;
    sum += point.visibility;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/** Bounding-box area of visible landmarks — larger = more likely the athlete. */
export function poseExtent(landmarks: readonly NormalizedLandmark[]): number {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  let n = 0;
  for (const point of landmarks) {
    if (!point || (point.visibility ?? 0) < MIN_VISIBILITY_PROXY) continue;
    n += 1;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (n < 4) return 0;
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

export function poseCentroid(
  landmarks: readonly NormalizedLandmark[],
): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const index of HIPS) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < MIN_VISIBILITY_PROXY) continue;
    sx += point.x;
    sy += point.y;
    n += 1;
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n };
}

/**
 * Prefer the largest pose; when a previous track exists, prefer the closest
 * centroid so racks/boxes do not steal the athlete mid-clip.
 */
export function pickBestPose(
  poses: readonly (readonly NormalizedLandmark[])[],
  prev: { x: number; y: number } | null,
): { landmarks: readonly NormalizedLandmark[]; centroid: { x: number; y: number } } | null {
  let best: { landmarks: readonly NormalizedLandmark[]; centroid: { x: number; y: number }; score: number } | null =
    null;
  for (const landmarks of poses) {
    if (!landmarks?.length) continue;
    const extent = poseExtent(landmarks);
    if (extent <= 0) continue;
    const centroid = poseCentroid(landmarks);
    if (!centroid) continue;
    let score = extent * 10;
    if (prev) {
      const dist = Math.hypot(centroid.x - prev.x, centroid.y - prev.y);
      score += Math.max(0, 2 - dist * 4);
    }
    if (!best || score > best.score) best = { landmarks, centroid, score };
  }
  return best ? { landmarks: best.landmarks, centroid: best.centroid } : null;
}

export function footY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  return lowestPoint(landmarks, ANKLE_HEEL, MIN_VISIBILITY);
}

export function upperFootY(landmarks: readonly NormalizedLandmark[] | undefined): number | null {
  if (!landmarks) return null;
  const left = lowestPoint(landmarks, LEFT_ANKLE_HEEL, MIN_VISIBILITY);
  const right = lowestPoint(landmarks, RIGHT_ANKLE_HEEL, MIN_VISIBILITY);
  if (left === null || right === null) return null;
  return Math.min(left, right);
}

export interface LandmarkVisStats {
  ankle: number | null;
  heel: number | null;
  knee: number | null;
  hip: number | null;
}

export function visibilityStats(landmarks: readonly NormalizedLandmark[]): LandmarkVisStats {
  return {
    ankle: meanVisibility(landmarks, ANKLES),
    heel: meanVisibility(landmarks, HEELS),
    knee: meanVisibility(landmarks, KNEES),
    hip: meanVisibility(landmarks, HIPS),
  };
}

export function sampleFromLandmarks(
  landmarks: readonly NormalizedLandmark[] | undefined,
  frame: number,
): FootSample | null {
  if (!landmarks?.length) return null;
  const feetXY = lowestPointXY(landmarks, ANKLE_HEEL, MIN_VISIBILITY);
  const kneesXY = lowestPointXY(landmarks, KNEES, MIN_VISIBILITY_PROXY);
  const hip = meanPoint(landmarks, HIPS, MIN_VISIBILITY_PROXY);
  const hipX = meanPointX(landmarks, HIPS, MIN_VISIBILITY_PROXY);
  const upper = upperFootY(landmarks);

  let contact: number | null = feetXY?.y ?? null;
  let contactX: number | null = feetXY?.x ?? null;
  if (contact === null && kneesXY !== null) {
    contact = kneesXY.y;
    contactX = kneesXY.x;
  }
  if (contact === null && hip !== null) {
    contact = Math.min(0.98, hip + 0.28);
    contactX = hipX;
  }
  if (contact === null) return null;

  const sample: FootSample = { frame, footY: contact };
  if (contactX !== null) sample.footX = contactX;
  if (upper !== null) sample.upperFootY = upper;
  const leftY = lowestPoint(landmarks, LEFT_ANKLE_HEEL, MIN_VISIBILITY);
  const rightY = lowestPoint(landmarks, RIGHT_ANKLE_HEEL, MIN_VISIBILITY);
  if (leftY !== null) sample.leftFootY = leftY;
  if (rightY !== null) sample.rightFootY = rightY;
  const leftHeel = landmarks[29];
  const rightHeel = landmarks[30];
  if (leftHeel && (leftHeel.visibility ?? 1) >= MIN_VISIBILITY) {
    sample.leftHeelX = leftHeel.x;
    sample.leftHeelY = leftHeel.y;
  }
  if (rightHeel && (rightHeel.visibility ?? 1) >= MIN_VISIBILITY) {
    sample.rightHeelX = rightHeel.x;
    sample.rightHeelY = rightHeel.y;
  }
  const heelVis = meanVisibility(landmarks, HEELS);
  if (heelVis !== null) sample.heelVis = heelVis;
  if (hip !== null) sample.hipY = hip;
  const heel = contactHeelXY(landmarks, contactX);
  if (heel) {
    sample.heelX = heel.x;
    sample.heelY = heel.y;
  }
  return sample;
}

/** Prefer the heel on the contact-foot side; else the lower (floor) heel. */
function contactHeelXY(
  landmarks: readonly NormalizedLandmark[],
  contactX: number | null,
): { x: number; y: number } | null {
  const left = landmarks[29];
  const right = landmarks[30];
  const leftOk = left && (left.visibility ?? 1) >= MIN_VISIBILITY;
  const rightOk = right && (right.visibility ?? 1) >= MIN_VISIBILITY;
  if (leftOk && rightOk && contactX !== null) {
    return Math.abs(left.x - contactX) <= Math.abs(right.x - contactX)
      ? { x: left.x, y: left.y }
      : { x: right.x, y: right.y };
  }
  if (leftOk && rightOk) {
    return left.y >= right.y ? { x: left.x, y: left.y } : { x: right.x, y: right.y };
  }
  if (leftOk) return { x: left.x, y: left.y };
  if (rightOk) return { x: right.x, y: right.y };
  return null;
}

function meanPointX(
  landmarks: readonly NormalizedLandmark[],
  indexes: readonly number[],
  minVisibility: number,
): number | null {
  let sum = 0;
  let n = 0;
  for (const index of indexes) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < minVisibility) continue;
    sum += point.x;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

export interface AnalyzeOptions {
  video: HTMLVideoElement;
  seeker: FrameSeeker;
  frameCount: number;
  onProgress: (message: string, fraction?: number) => void;
  signal: AbortSignal;
  /** Capture fps for real-time validation (e.g. 207). */
  captureFps?: number;
  /** Slow-mo stretch dividing presentation timestamps. */
  stretch?: number;
  frameTimes?: readonly number[];
  /** lite (default) or heavy (High accuracy — slower, lazy-loaded). */
  poseQuality?: PoseModelQuality;
  /** Auto (default) or fixed 1–4 jumps in this clip. */
  jumpCount?: JumpCountChoice;
  /** When false, Auto does not require a box drop (one-step / penultimate). */
  requireDrop?: boolean;
  /** Display label for diagnostics (e.g. "Penultimate / Approach"). */
  jumpTypeLabel?: string;
}

interface SamplePass {
  samples: FootSample[];
  framesScanned: number;
  framesWithPerson: number;
  ankleVis: number[];
  heelVis: number[];
  kneeVis: number[];
  hipVis: number[];
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function formatEta(secondsLeft: number): string {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return "";
  if (secondsLeft < 5) return "~a few seconds left";
  if (secondsLeft < 60) return `~${Math.ceil(secondsLeft)}s left`;
  return `~${Math.ceil(secondsLeft / 60)} min left`;
}

async function sampleFrames(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  seeker: FrameSeeker,
  frames: readonly number[],
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  signal: AbortSignal,
  onProgress: (message: string, fraction?: number) => void,
  label: string,
  prevCentroid: { x: number; y: number } | null,
  progressOffset = 0,
  progressSpan = 1,
): Promise<SamplePass & { lastCentroid: { x: number; y: number } | null }> {
  const samples: FootSample[] = [];
  const ankleVis: number[] = [];
  const heelVis: number[] = [];
  const kneeVis: number[] = [];
  const hipVis: number[] = [];
  let framesWithPerson = 0;
  let lastCentroid = prevCentroid;
  const started = performance.now();

  for (let i = 0; i < frames.length; i += 1) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const frame = frames[i]!;
    await seeker.settle(frame);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = landmarker.detect(canvas);
    const picked = pickBestPose(result.landmarks ?? [], lastCentroid);
    if (picked) {
      framesWithPerson += 1;
      lastCentroid = picked.centroid;
      const vis = visibilityStats(picked.landmarks);
      if (vis.ankle !== null) ankleVis.push(vis.ankle);
      if (vis.heel !== null) heelVis.push(vis.heel);
      if (vis.knee !== null) kneeVis.push(vis.knee);
      if (vis.hip !== null) hipVis.push(vis.hip);
      const sample = sampleFromLandmarks(picked.landmarks, frame);
      if (sample) samples.push(sample);
    }
    if (i % 4 === 0 || i === frames.length - 1) {
      const done = i + 1;
      const elapsed = (performance.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const left = (frames.length - done) / Math.max(rate, 0.001);
      const frac = progressOffset + progressSpan * (done / frames.length);
      const eta = formatEta(left);
      onProgress(
        `${label} ${done} / ${frames.length}${eta ? ` · ${eta}` : ""}`,
        frac,
      );
      await yieldToUi();
    }
  }
  return {
    samples,
    framesScanned: frames.length,
    framesWithPerson,
    ankleVis,
    heelVis,
    kneeVis,
    hipVis,
    lastCentroid,
  };
}

function prepareCanvas(video: HTMLVideoElement): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} | null {
  const longSide = Math.max(video.videoWidth, video.videoHeight) || 1;
  const scale = Math.min(1, INPUT_EDGE / longSide);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  // Alpha-less buffer; reuse for every frame (no per-frame canvas alloc).
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) return null;
  return { canvas, context };
}

function mergeDiag(passes: SamplePass[]): Partial<DetectDiagnostics> {
  const ankle: number[] = [];
  const heel: number[] = [];
  const knee: number[] = [];
  const hip: number[] = [];
  let scanned = 0;
  let withPerson = 0;
  for (const pass of passes) {
    scanned += pass.framesScanned;
    withPerson += pass.framesWithPerson;
    ankle.push(...pass.ankleVis);
    heel.push(...pass.heelVis);
    knee.push(...pass.kneeVis);
    hip.push(...pass.hipVis);
  }
  return {
    framesScanned: scanned,
    framesWithPerson: withPerson,
    medianAnkleVis: median(ankle),
    medianHeelVis: median(heel),
    medianKneeVis: median(knee),
    medianHipVis: median(hip),
  };
}

export async function analyzeClip(options: AnalyzeOptions): Promise<Detection> {
  const multi = await analyzeMultiClip(options);
  if (!multi.ok) return multi;
  const events = multi.jumps[0];
  if (!events) {
    return {
      ok: false,
      reason: "No jump found. Mark touchdown, takeoff, and landing by hand.",
      diagnostics: multi.diagnostics,
    };
  }
  return {
    ok: true,
    model: multi.model,
    events,
    lowConfidence: multi.lowConfidence,
    diagnostics: multi.diagnostics,
  };
}

/**
 * Scan the clip (coarse then refine). Classic single-jump first; multi only
 * when 2+ clear cycles. Always attaches diagnostics for the Advanced panel.
 */
export async function analyzeMultiClip(
  options: AnalyzeOptions,
): Promise<MultiDetection & { samples?: FootSample[] }> {
  const { video, seeker, frameCount, onProgress, signal } = options;
  const quality: PoseModelQuality = options.poseQuality === "heavy" ? "heavy" : "lite";
  onProgress(
    quality === "heavy"
      ? "Loading high-accuracy pose model (slower)…"
      : "Loading pose model…",
    0.02,
  );
  const landmarker = await loadLandmarker(quality);
  const prepared = prepareCanvas(video);
  if (!prepared) {
    return {
      ok: false,
      reason: "Canvas is not available. Mark events by hand.",
      diagnostics: emptyDiagnostics({ rejectStage: "no_samples" }),
    };
  }
  const { canvas, context } = prepared;

  const timing: JumpTimingContext = {
    captureFps: options.captureFps ?? 240,
    stretch: options.stretch ?? 1,
    frameTimes: options.frameTimes,
  };

  const step = frameCount <= 800 ? 1 : scanStep(frameCount);
  const coarse = coarseFrames(frameCount, step);
  onProgress(`Scanning ${coarse.length} frames…`, 0.05);
  const coarsePass = await sampleFrames(
    landmarker,
    video,
    seeker,
    coarse,
    canvas,
    context,
    signal,
    onProgress,
    "Scan",
    null,
    0.05,
    0.7,
  );

  const scanDiag = mergeDiag([coarsePass]);
  if (coarsePass.samples.length < 5) {
    return {
      ok: false,
      reason:
        "No plausible jump found — pose saw too few body landmarks. Mark touchdown, takeoff, and landing by hand.",
      diagnostics: emptyDiagnostics({
        ...scanDiag,
        rejectStage: "no_samples",
        notes: ["Try High accuracy (slower), better lighting, or mark manually."],
      }),
    };
  }

  let single = detectEvents(coarsePass.samples, undefined, 3, scanDiag, timing);
  const refineTargets: DetectedEvents[] = [];
  if (single.ok) refineTargets.push(single.events);
  const multiCoarse = detectAllEvents(coarsePass.samples, { maxJumps: 8, timing });
  if (multiCoarse.ok && multiCoarse.jumps.length >= 2) {
    for (const jump of multiCoarse.jumps) refineTargets.push(jump);
  }

  if (refineTargets.length === 0) {
    return {
      ok: false,
      reason: single.ok === false
        ? single.reason
        : "No plausible jump found. Mark touchdown, takeoff, and landing by hand.",
      diagnostics: single.diagnostics,
    };
  }

  const refineSet = new Set<number>();
  for (const jump of refineTargets) {
    for (const frame of refineFrames(jump, Math.max(step, 2), frameCount)) refineSet.add(frame);
  }
  const refineList = [...refineSet].sort((a, b) => a - b);
  onProgress(`Refining ${refineList.length} frames…`, 0.75);
  const finePass = await sampleFrames(
    landmarker,
    video,
    seeker,
    refineList,
    canvas,
    context,
    signal,
    onProgress,
    "Refine",
    coarsePass.lastCentroid,
    0.75,
    0.24,
  );

  const merged = [...coarsePass.samples, ...finePass.samples];
  const mergedDiag = mergeDiag([coarsePass, finePass]);
  single = detectEvents(merged, single.ok ? single.model : undefined, 3, mergedDiag, timing);
  const multi = detectAllEvents(merged, {
    fixedModel: multiCoarse.ok ? multiCoarse.model : single.ok ? single.model : undefined,
    maxJumps: 8,
    timing,
  });

  const candidatePool = [
    ...(single.diagnostics.candidates ?? []),
    ...(multi.ok ? multi.diagnostics.candidates : []),
  ];
  // Dedupe by marks.
  const seen = new Set<string>();
  const candidates = candidatePool.filter((c) => {
    const key = `${c.touchdown}:${c.takeoff}:${c.landing}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const stepOffHint =
    single.ok && single.events.stepOff !== null
      ? single.events.stepOff
      : candidates.map((c) => c.stepOff).find((v) => v !== null) ?? null;

  const requireDrop = options.requireDrop !== false;
  const resolved = resolveJumpSet(candidates, timing, {
    stepOffHint: requireDrop ? stepOffHint : null,
    jumpCount: options.jumpCount ?? "auto",
    requireDrop,
  });
  const diagBase: DetectDiagnostics = {
    ...(single.ok ? single.diagnostics : multi.ok ? multi.diagnostics : single.diagnostics),
    ...mergedDiag,
    jumpType: options.jumpTypeLabel,
    candidates: candidates.sort((a, b) => b.score - a.score),
    notes: [
      ...(single.diagnostics.notes ?? []),
      `Pose model: ${quality}`,
      `Jumps in clip: ${options.jumpCount ?? "auto"}`,
      `Require drop/step-off: ${requireDrop ? "yes" : "no (approach)"}`,
      ...resolved.notes,
      ...resolved.warnings,
      ...resolved.rejected.slice(0, 6).map((r) => `Rejected TD${r.touchdown}: ${r.rejectReason}`),
    ],
    lowConfidence: resolved.lowConfidence || resolved.warnings.length > 0,
    rejectStage: resolved.jumps.length && !resolved.implausible ? "ok" : single.diagnostics.rejectStage,
  };

  const jumpModel: GroundModel | null =
    (single.ok ? single.model : null) ??
    (multi.ok ? multi.model : null) ??
    groundModel(merged);

  // Never apply physically implausible marks — fall back to manual.
  if (resolved.implausible || !resolved.jumps.length || !jumpModel) {
    return {
      ok: false,
      reason:
        "No plausible jump found (contact 80–1000 ms, flight ≥150 ms). Mark touchdown, takeoff, and landing by hand.",
      diagnostics: {
        ...diagBase,
        lowConfidence: true,
        notes: [...diagBase.notes, ...resolved.notes],
      },
      // Keep pose samples so changing jump type can re-resolve without a full re-pose.
      samples: merged,
    };
  }

  // Dense-enough XY samples along the main flight for the foot-path overlay.
  let pathSamples = merged;
  const main = resolved.jumps[0];
  if (main) {
    const flightSpan = main.landing - main.takeoff;
    const pathStep = flightSpan > 120 ? 3 : flightSpan > 60 ? 2 : 1;
    const pathFrames: number[] = [];
    for (let f = main.takeoff; f <= main.landing; f += pathStep) pathFrames.push(f);
    if (pathFrames[pathFrames.length - 1] !== main.landing) pathFrames.push(main.landing);
    if (pathFrames.length > 2) {
      onProgress(`Foot path ${pathFrames.length} frames…`, 0.96);
      const pathPass = await sampleFrames(
        landmarker,
        video,
        seeker,
        pathFrames,
        canvas,
        context,
        signal,
        onProgress,
        "Path",
        finePass.lastCentroid,
        0.96,
        0.03,
      );
      pathSamples = [...merged, ...pathPass.samples];
    }
  }

  return {
    ok: true,
    jumps: resolved.jumps,
    model: jumpModel,
    lowConfidence: resolved.lowConfidence || resolved.warnings.length > 0,
    diagnostics: diagBase,
    samples: pathSamples,
  };
}

export type { DetectedEvents, GroundModel };
