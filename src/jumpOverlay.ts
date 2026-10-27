import type { FootSample } from "./detect.ts";

/**
 * High-contrast overlay palette (readable on dark and light video).
 * Shared by on-screen canvas, PNG card, and video export.
 */
export const OVERLAY = {
  heelDot: "#ff2d95",
  heelDotOutline: "#ffffff",
  trail: "#00e5ff",
  trailOutline: "#0a0a0a",
  trailOpacityMax: 0.4,
  trailOpacityMin: 0.12,
  apex: "#c8ff00",
  apexOutline: "#111111",
  labelText: "#c8ff00",
  labelBack: "rgba(10, 10, 10, 0.78)",
} as const;

/** @deprecated kept for tests that check palette left yellow/gray era */
export const OVERLAY_LINE = OVERLAY.trailOutline;
export const OVERLAY_TEXT = OVERLAY.labelText;
export const OVERLAY_TEXT_BACK = OVERLAY.labelBack;

export interface FootPoint {
  frame: number;
  /** Normalized image X (0–1). */
  x: number;
  /** Normalized image Y (0–1, top → bottom). */
  y: number;
}

export interface JumpOverlayMetrics {
  heightIn: number;
  gctMs: number;
  rsi: number;
  /** Optional strip labels (defaults: Jump height / Contact time / RSI). */
  labels?: { height?: string; contact?: string; rsi?: string };
}

export interface JumpOverlayModel {
  /** Heel path takeoff→landing (trail source). */
  heelPath: FootPoint[];
  /** Frame of the heel peak during flight — used for card/export seek. */
  apexFrame: number;
  /** Heel at peak (top of vertical line). */
  heelApex: FootPoint;
  /** Floor Y just before takeoff (bottom of vertical line / tick). */
  floorY: number;
  takeoff: number;
  landing: number;
  /** Official flight-time jump height (in); label only — not scaled from pixels. */
  heightIn: number;
}

/** @deprecated alias — older tests/path helpers; heel path is preferred. */
export function footPathDuringFlight(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
): FootPoint[] {
  return heelPathDuringFlight(samples, takeoff, landing);
}

/** Apex = highest in air = smallest Y during flight (image Y grows downward). */
export function findFlightApex(path: readonly FootPoint[]): FootPoint | null {
  if (!path.length) return null;
  let best = path[0]!;
  for (const point of path) {
    if (point.y < best.y) best = point;
  }
  return best;
}

/** Heel landmark path during flight (falls back to foot XY when heel missing). */
export function heelPathDuringFlight(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
): FootPoint[] {
  if (!(takeoff < landing)) return [];
  const byFrame = new Map<number, FootPoint>();
  for (const sample of samples) {
    if (sample.frame < takeoff || sample.frame > landing) continue;
    const heelY = sample.heelY;
    const heelX = sample.heelX;
    if (heelY !== undefined && Number.isFinite(heelY) && heelX !== undefined && Number.isFinite(heelX)) {
      byFrame.set(sample.frame, { frame: sample.frame, x: heelX, y: heelY });
      continue;
    }
    if (!Number.isFinite(sample.footY)) continue;
    const x = sample.footX;
    if (x === undefined || !Number.isFinite(x)) continue;
    byFrame.set(sample.frame, { frame: sample.frame, x, y: sample.footY });
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

const APPROACH_TRAIL_PAD = 8;
const APPROACH_MIN_HEEL_VIS = 0.15;
/** Max normalized step between consecutive trail points (rejects foot-switch outliers). */
const APPROACH_MAX_STEP = 0.07;
const APPROACH_MEDIAN_WIN = 5;

function heelSideXY(
  sample: FootSample,
  side: "L" | "R",
): { x: number; y: number } | null {
  if (side === "L") {
    if (
      sample.leftHeelX !== undefined &&
      sample.leftHeelY !== undefined &&
      Number.isFinite(sample.leftHeelX) &&
      Number.isFinite(sample.leftHeelY)
    ) {
      return { x: sample.leftHeelX, y: sample.leftHeelY };
    }
    return null;
  }
  if (
    sample.rightHeelX !== undefined &&
    sample.rightHeelY !== undefined &&
    Number.isFinite(sample.rightHeelX) &&
    Number.isFinite(sample.rightHeelY)
  ) {
    return { x: sample.rightHeelX, y: sample.rightHeelY };
  }
  return null;
}

function pickPlantHeelSide(samples: readonly FootSample[], takeoff: number): "L" | "R" | null {
  let best: { side: "L" | "R"; y: number } | null = null;
  for (const sample of samples) {
    if (sample.frame < takeoff - 4 || sample.frame > takeoff + 2) continue;
    for (const side of ["L", "R"] as const) {
      const xy = heelSideXY(sample, side);
      if (!xy) continue;
      if (!best || xy.y > best.y) best = { side, y: xy.y };
    }
  }
  return best?.side ?? null;
}

function movingMedianXY(points: readonly FootPoint[], window: number): FootPoint[] {
  if (points.length <= 2 || window < 3) return [...points];
  const half = Math.floor(window / 2);
  const out: FootPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const from = Math.max(0, i - half);
    const to = Math.min(points.length, i + half + 1);
    const xs = points.slice(from, to).map((p) => p.x).sort((a, b) => a - b);
    const ys = points.slice(from, to).map((p) => p.y).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    out.push({
      frame: points[i]!.frame,
      x: xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2,
      y: ys.length % 2 ? ys[mid]! : (ys[mid - 1]! + ys[mid]!) / 2,
    });
  }
  return out;
}

/**
 * Approach trail: lock to plant/takeoff heel (or nearest heel to prior point),
 * drop low-vis / velocity outliers, median-smooth, draw from shortly before
 * plant TD through landing. Build-s magenta/cyan palette unchanged.
 */
export function heelPathForApproach(
  samples: readonly FootSample[],
  plantTouchdown: number | null,
  takeoff: number,
  landing: number,
): FootPoint[] {
  if (!(takeoff < landing)) return [];
  const start = Math.max(
    0,
    plantTouchdown !== null && plantTouchdown >= 0
      ? plantTouchdown - APPROACH_TRAIL_PAD
      : takeoff - APPROACH_TRAIL_PAD,
  );
  const locked = pickPlantHeelSide(samples, takeoff);
  const ordered = [...samples]
    .filter((s) => s.frame >= start && s.frame <= landing)
    .sort((a, b) => a.frame - b.frame);

  const raw: FootPoint[] = [];
  let prev: FootPoint | null = null;
  for (const sample of ordered) {
    if (sample.heelVis !== undefined && sample.heelVis < APPROACH_MIN_HEEL_VIS) continue;

    let xy: { x: number; y: number } | null = null;
    if (locked) xy = heelSideXY(sample, locked);
    if (!xy) {
      const left = heelSideXY(sample, "L");
      const right = heelSideXY(sample, "R");
      if (left && right && prev) {
        const dL = Math.hypot(left.x - prev.x, left.y - prev.y);
        const dR = Math.hypot(right.x - prev.x, right.y - prev.y);
        xy = dL <= dR ? left : right;
      } else {
        xy = left ?? right;
      }
    }
    if (!xy) {
      if (
        sample.heelX !== undefined &&
        sample.heelY !== undefined &&
        Number.isFinite(sample.heelX) &&
        Number.isFinite(sample.heelY)
      ) {
        xy = { x: sample.heelX, y: sample.heelY };
      } else if (
        sample.footX !== undefined &&
        Number.isFinite(sample.footX) &&
        Number.isFinite(sample.footY)
      ) {
        xy = { x: sample.footX, y: sample.footY };
      }
    }
    if (!xy) continue;

    const point: FootPoint = { frame: sample.frame, x: xy.x, y: xy.y };
    if (prev) {
      const step = Math.hypot(point.x - prev.x, point.y - prev.y);
      const frameGap = Math.max(1, point.frame - prev.frame);
      if (step / frameGap > APPROACH_MAX_STEP) continue; // outlier / foot switch
    }
    raw.push(point);
    prev = point;
  }
  return movingMedianXY(raw, APPROACH_MEDIAN_WIN);
}

/**
 * Floor = lowest heel/foot (largest Y) in a short window ending at takeoff.
 */
export function floorLevelNearTakeoff(
  samples: readonly FootSample[],
  takeoff: number,
): number | null {
  let best: number | null = null;
  const from = takeoff - 6;
  for (const sample of samples) {
    if (sample.frame < from || sample.frame > takeoff) continue;
    const y =
      sample.heelY !== undefined && Number.isFinite(sample.heelY) ? sample.heelY : sample.footY;
    if (!Number.isFinite(y)) continue;
    if (best === null || y > best) best = y;
  }
  return best;
}

/** Heel path points at or before `throughFrame` (inclusive). */
export function heelTrailThrough(
  heelPath: readonly FootPoint[],
  throughFrame: number,
): FootPoint[] {
  return heelPath.filter((p) => p.frame <= throughFrame);
}

/** Nearest heel sample at or before `frame`; else first point. */
export function heelAtFrame(
  heelPath: readonly FootPoint[],
  frame: number,
): FootPoint | null {
  if (!heelPath.length) return null;
  let best: FootPoint | null = null;
  for (const point of heelPath) {
    if (point.frame > frame) break;
    best = point;
  }
  return best ?? heelPath[0]!;
}

export function buildJumpOverlayModel(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
  heightIn: number,
  options: { approach?: boolean; plantTouchdown?: number | null } = {},
): JumpOverlayModel | null {
  const heelPath = options.approach
    ? heelPathForApproach(samples, options.plantTouchdown ?? null, takeoff, landing)
    : heelPathDuringFlight(samples, takeoff, landing);
  const heelApex = findFlightApex(heelPath);
  if (!heelApex) return null;

  const floorY = floorLevelNearTakeoff(samples, takeoff);
  if (floorY === null) return null;

  return {
    heelPath,
    apexFrame: heelApex.frame,
    heelApex,
    floorY,
    takeoff,
    landing,
    heightIn,
  };
}

function strokeTrailSegment(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  opacity: number,
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Dark outline for contrast on light backgrounds
  ctx.globalAlpha = Math.min(1, opacity + 0.25);
  ctx.strokeStyle = OVERLAY.trailOutline;
  ctx.lineWidth = width + 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  // Cyan trail
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = OVERLAY.trail;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Pre-t cream metrics strip, drawn on-image and lifted above the bottom edge
 * so Instagram crops (4:5 / 9:16 / 1:1) are less likely to clip it.
 */
export const METRICS_BOTTOM_LIFT = 0.09;

export function metricsStripHeight(width: number): number {
  return Math.max(96, Math.round(width * 0.18));
}

/** Cream strip rect: same size as pre-t, bottom edge ~9% up from the frame bottom. */
export function metricsStripRect(
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const h = metricsStripHeight(width);
  const lift = height * METRICS_BOTTOM_LIFT;
  const y = Math.max(0, height - h - lift);
  return { x: 0, y, w: width, h };
}

/** Jump height / Contact time / RSI — exact pre-t cream style. */
export function drawMetricsStrip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  tableH: number,
  metrics: JumpOverlayMetrics,
): void {
  ctx.fillStyle = "#f3f0e7";
  ctx.fillRect(x, y, width, tableH);
  ctx.strokeStyle = "#e2dccf";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.stroke();

  const cols = [
    {
      label: metrics.labels?.height ?? "Jump height",
      value: `${metrics.heightIn.toFixed(1)} in`,
    },
    {
      label: metrics.labels?.contact ?? "Contact time",
      value: `${Math.round(metrics.gctMs)} ms`,
    },
    { label: metrics.labels?.rsi ?? "RSI", value: metrics.rsi.toFixed(2) },
  ];
  const colW = width / 3;
  cols.forEach((col, i) => {
    const cx = x + colW * i + colW / 2;
    ctx.fillStyle = "#6d675c";
    ctx.font = `600 ${Math.max(11, Math.round(width * 0.028))}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(col.label, cx, y + tableH * 0.38);
    ctx.fillStyle = "#1c1914";
    ctx.font = `600 ${Math.max(18, Math.round(width * 0.055))}px "Barlow Condensed", sans-serif`;
    ctx.fillText(col.value, cx, y + tableH * 0.72);
    if (i > 0) {
      ctx.strokeStyle = "#e2dccf";
      ctx.beginPath();
      ctx.moveTo(x + colW * i, y + 12);
      ctx.lineTo(x + colW * i, y + tableH - 12);
      ctx.stroke();
    }
  });
}

function drawApexHeight(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: JumpOverlayModel,
  metricsTop: number | null = null,
): void {
  const heel = {
    x: model.heelApex.x * width,
    y: model.heelApex.y * height,
  };
  const floorY = model.floorY * height;
  const x = heel.x;
  const lineWidth = Math.max(3, width * 0.008);
  const tick = Math.max(12, width * 0.032);

  ctx.save();
  ctx.lineCap = "round";
  // Dark outline
  ctx.strokeStyle = OVERLAY.apexOutline;
  ctx.lineWidth = lineWidth + 2.5;
  ctx.beginPath();
  ctx.moveTo(x, floorY);
  ctx.lineTo(x, heel.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - tick, floorY);
  ctx.lineTo(x + tick, floorY);
  ctx.stroke();
  // Bright lime
  ctx.strokeStyle = OVERLAY.apex;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x, floorY);
  ctx.lineTo(x, heel.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - tick, floorY);
  ctx.lineTo(x + tick, floorY);
  ctx.stroke();

  const tag = `${model.heightIn.toFixed(1)} in`;
  const fontPx = Math.max(15, Math.round(width * 0.048));
  ctx.font = `700 ${fontPx}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const padX = 8;
  const measured = ctx.measureText(tag);
  const boxW = measured.width + padX * 2;
  const boxH = Math.max(24, width * 0.058);
  let boxX = x + tick + 6;
  let boxY = (floorY + heel.y) / 2 - boxH / 2;
  if (boxX + boxW > width - 4) boxX = x - tick - 6 - boxW;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  boxY = Math.max(4, Math.min(height - boxH - 4, boxY));
  // Keep the apex height label above the cream metrics strip.
  if (metricsTop !== null && boxY + boxH > metricsTop - 6) {
    boxY = Math.max(4, metricsTop - 6 - boxH);
  }
  ctx.fillStyle = OVERLAY.labelBack;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = OVERLAY.apexOutline;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = OVERLAY.labelText;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(tag, boxX + padX, boxY + boxH / 2);
  ctx.restore();
}

/**
 * Build-s overlay: magenta heel dot, fading cyan trail, lime floor→heel apex
 * line + height label. Optional on-image cream metrics (lifted from bottom).
 * Shared by on-screen, PNG card, and video export.
 */
export function drawFootOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: JumpOverlayModel,
  options: {
    showTags?: boolean;
    currentFrame?: number | null;
    metrics?: JumpOverlayMetrics | null;
  } = {},
): void {
  void options.showTags;
  const px = (p: FootPoint) => ({ x: p.x * width, y: p.y * height });
  const fullTrail = options.currentFrame == null;
  const through = fullTrail ? model.landing : options.currentFrame!;
  const trail = heelTrailThrough(model.heelPath, through);
  const trailWidth = Math.max(1.25, width * 0.0035);
  const strip = options.metrics ? metricsStripRect(width, height) : null;

  if (trail.length >= 2) {
    const n = trail.length - 1;
    for (let i = 0; i < n; i += 1) {
      const t = n === 1 ? 1 : i / (n - 1);
      const opacity =
        OVERLAY.trailOpacityMin + (OVERLAY.trailOpacityMax - OVERLAY.trailOpacityMin) * t;
      strokeTrailSegment(ctx, px(trail[i]!), px(trail[i + 1]!), trailWidth, opacity);
    }
  }

  const showApex = fullTrail || (options.currentFrame !== null && options.currentFrame! >= model.apexFrame);
  if (showApex) {
    drawApexHeight(ctx, width, height, model, strip?.y ?? null);
  }

  const heelNow = fullTrail ? model.heelApex : heelAtFrame(model.heelPath, through);
  if (heelNow) {
    const p = px(heelNow);
    const r = Math.max(6, width * 0.014);
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = OVERLAY.heelDotOutline;
    ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = OVERLAY.heelDot;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Metrics last so the cream strip stays readable; full opacity all frames.
  if (options.metrics && strip) {
    drawMetricsStrip(ctx, strip.x, strip.y, strip.w, strip.h, options.metrics);
  }
}

/**
 * Compose export card: frame-sized PNG with build-s overlays + lifted cream metrics.
 */
export function composeJumpCardPng(
  videoFrame: CanvasImageSource,
  frameW: number,
  frameH: number,
  model: JumpOverlayModel,
  metrics: JumpOverlayMetrics,
): Blob | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, frameW);
  canvas.height = Math.max(1, frameH);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#1c1914";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(videoFrame, 0, 0, frameW, frameH);
  drawFootOverlay(ctx, frameW, frameH, model, { currentFrame: null, metrics });

  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/** Prefer mp4 for iPhone Share/Save; fall back to webm. */
export function pickRecorderMime(): { mimeType: string; ext: "mp4" | "webm" } {
  const candidates: { mimeType: string; ext: "mp4" | "webm" }[] = [
    { mimeType: "video/mp4", ext: "mp4" },
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "", ext: "webm" };
}

/** Short note for the export-ready panel about recorded container. */
export function recorderFormatNote(ext: string, recordedMime = ""): string {
  const isMp4 = ext === "mp4" || recordedMime.includes("mp4");
  return isMp4
    ? "Recorded as MP4."
    : "Recorded as WebM (MP4 wasn’t supported on this device).";
}

/** Which preview media to show after export — never both (card XOR video). */
export function exportReadyMediaVisibility(kind: "video" | "image"): {
  showVideo: boolean;
  showImage: boolean;
} {
  return kind === "video"
    ? { showVideo: true, showImage: false }
    : { showVideo: false, showImage: true };
}

export function exportVideoFrameRange(
  stepOff: number | null,
  takeoff: number,
  landing: number,
  frameCount: number,
  padAfterLanding: number,
): { start: number; end: number } {
  const start = Math.max(0, stepOff !== null && stepOff <= takeoff ? stepOff : Math.max(0, takeoff - 2));
  const end = Math.min(Math.max(0, frameCount - 1), landing + Math.max(0, padAfterLanding));
  return { start, end: Math.max(start, end) };
}

export type ExportPlaybackSpeed = 1 | 0.5 | 0.25;

export function parseExportPlaybackSpeed(raw: string): ExportPlaybackSpeed {
  if (raw === "1") return 1;
  if (raw === "0.5") return 0.5;
  return 0.25;
}

/** Wall-clock ms to hold between consecutive frames for watchable slow-mo. */
export function exportFrameHoldMs(
  realSeconds: number,
  playbackSpeed: ExportPlaybackSpeed,
): number {
  if (!(realSeconds > 0) || !(playbackSpeed > 0)) return 1000 / 30;
  return Math.max(8, (realSeconds / playbackSpeed) * 1000);
}
