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
): JumpOverlayModel | null {
  const heelPath = heelPathDuringFlight(samples, takeoff, landing);
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
 * Instagram-safe metrics band: ~12% from top, inside top third;
 * keep bottom ~15% clear of important chrome.
 */
export const METRICS_SAFE = {
  topMargin: 0.12,
  bottomClear: 0.15,
  bandHeight: 0.1,
} as const;

export function metricsBandRect(
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const y = height * METRICS_SAFE.topMargin;
  const maxBottom = height / 3;
  const h = Math.min(
    Math.max(52, height * METRICS_SAFE.bandHeight),
    Math.max(40, maxBottom - y),
  );
  return { x: 0, y, w: width, h };
}

/** Fade in at takeoff, then stay; full opacity for still card (null frame). */
export function metricsBandOpacity(
  currentFrame: number | null | undefined,
  takeoff: number,
): number {
  if (currentFrame == null) return 1;
  if (currentFrame < takeoff) return 0;
  const fadeFrames = 5;
  if (currentFrame < takeoff + fadeFrames) {
    return (currentFrame - takeoff + 1) / fadeFrames;
  }
  return 1;
}

/** On-image Jump height / Contact time / RSI band (card + video). */
export function drawMetricsBand(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  metrics: JumpOverlayMetrics,
  opacity = 1,
): { y: number; h: number } {
  const band = metricsBandRect(width, height);
  if (!(opacity > 0)) return { y: band.y, h: band.h };

  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
  ctx.fillStyle = "rgba(8, 8, 10, 0.72)";
  ctx.fillRect(band.x, band.y, band.w, band.h);

  const cols = [
    { label: "Jump height", value: `${metrics.heightIn.toFixed(1)} in` },
    { label: "Contact time", value: `${Math.round(metrics.gctMs)} ms` },
    { label: "RSI", value: metrics.rsi.toFixed(2) },
  ];
  const colW = band.w / 3;
  const labelPx = Math.max(11, Math.round(width * 0.028));
  const valuePx = Math.max(20, Math.round(width * 0.055));
  cols.forEach((col, i) => {
    const cx = band.x + colW * i + colW / 2;
    ctx.fillStyle = "rgba(245, 245, 245, 0.85)";
    ctx.font = `600 ${labelPx}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(col.label, cx, band.y + band.h * 0.36);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${valuePx}px "Barlow Condensed", sans-serif`;
    ctx.fillText(col.value, cx, band.y + band.h * 0.78);
    if (i > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(band.x + colW * i, band.y + band.h * 0.18);
      ctx.lineTo(band.x + colW * i, band.y + band.h * 0.82);
      ctx.stroke();
    }
  });
  ctx.restore();
  return { y: band.y, h: band.h };
}

function drawApexHeight(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: JumpOverlayModel,
): void {
  const heel = {
    x: model.heelApex.x * width,
    y: model.heelApex.y * height,
  };
  const floorY = model.floorY * height;
  const x = heel.x;
  const lineWidth = Math.max(3, width * 0.008);
  const tick = Math.max(12, width * 0.032);
  const band = metricsBandRect(width, height);
  const bandBottom = band.y + band.h + 8;
  const bottomLimit = height * (1 - METRICS_SAFE.bottomClear);

  ctx.save();
  ctx.lineCap = "round";
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
  const textW = ctx.measureText(tag).width;
  const boxW = textW + padX * 2;
  const boxH = Math.max(24, width * 0.058);
  let boxX = x + tick + 6;
  let boxY = (floorY + heel.y) / 2 - boxH / 2;
  if (boxX + boxW > width - 4) boxX = x - tick - 6 - boxW;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  // Keep height label out of the metrics band and out of the bottom crop zone.
  if (boxY < bandBottom) boxY = bandBottom;
  if (boxY + boxH > bottomLimit) boxY = Math.max(bandBottom, bottomLimit - boxH);
  boxY = Math.max(bandBottom, Math.min(height - boxH - 4, boxY));
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
 * Moving heel dot + growing faint trail; apex floor→heel line + height label
 * when at/after apex (or always when currentFrame is null — jump card).
 * Optional on-image metrics band (Instagram-safe). Shared by screen/card/video.
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

  if (options.metrics) {
    const opacity = metricsBandOpacity(options.currentFrame, model.takeoff);
    drawMetricsBand(ctx, width, height, options.metrics, opacity);
  }

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
    drawApexHeight(ctx, width, height, model);
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
}

/**
 * Compose export card: video frame + overlays + on-image metrics band.
 * Canvas matches the frame (no bottom table). Full trail + apex.
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
