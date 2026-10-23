import type { FootSample } from "./detect.ts";

/** Shared overlay chrome — used by on-screen canvas, PNG card, and video export. */
export const OVERLAY_LINE = "#3a3a3a";
export const OVERLAY_TEXT = "#1a2a6c";
export const OVERLAY_TEXT_BACK = "rgba(255, 255, 255, 0.78)";

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
  path: FootPoint[];
  /** Frame of the heel peak during flight — used for card/export seek. */
  apexFrame: number;
  /** Heel at peak (dot + top of vertical line). */
  heelApex: FootPoint;
  /** Floor Y just before takeoff (bottom of vertical line / tick). */
  floorY: number;
  takeoff: number;
  landing: number;
  /** Official flight-time jump height (in); label only — not scaled from pixels. */
  heightIn: number;
}

/** Points from takeoff→landing with usable XY, sorted by frame. */
export function footPathDuringFlight(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
): FootPoint[] {
  if (!(takeoff < landing)) return [];
  const byFrame = new Map<number, FootPoint>();
  for (const sample of samples) {
    if (sample.frame < takeoff || sample.frame > landing) continue;
    if (!Number.isFinite(sample.footY)) continue;
    const x = sample.footX;
    if (x === undefined || !Number.isFinite(x)) continue;
    byFrame.set(sample.frame, { frame: sample.frame, x, y: sample.footY });
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** Apex = highest in air = smallest footY during flight (image Y grows downward). */
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

export function buildJumpOverlayModel(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
  heightIn: number,
): JumpOverlayModel | null {
  const path = footPathDuringFlight(samples, takeoff, landing);
  if (!path.length) return null;

  const heelPath = heelPathDuringFlight(samples, takeoff, landing);
  const heelApex = findFlightApex(heelPath);
  if (!heelApex) return null;

  const floorY = floorLevelNearTakeoff(samples, takeoff);
  if (floorY === null) return null;

  return {
    path,
    apexFrame: heelApex.frame,
    heelApex,
    floorY,
    takeoff,
    landing,
    heightIn,
  };
}

/**
 * Foot path + one vertical heel-height line (floor tick → heel apex) with
 * official flight-time label. Shared by on-screen, PNG card, and video export.
 */
export function drawFootOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: JumpOverlayModel,
  options: { showTags?: boolean; currentFrame?: number | null } = {},
): void {
  const showTags = options.showTags !== false;
  const px = (p: FootPoint) => ({ x: p.x * width, y: p.y * height });
  const pathWidth = Math.max(1.9, width * 0.006);
  const lineWidth = Math.max(2.5, width * 0.007);
  const pointR = Math.max(3.5, width * 0.009);
  const heelR = Math.max(5, width * 0.012);

  if (model.path.length >= 2) {
    ctx.save();
    ctx.strokeStyle = OVERLAY_LINE;
    ctx.lineWidth = pathWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    const first = px(model.path[0]!);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < model.path.length; i += 1) {
      const p = px(model.path[i]!);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (showTags) {
    for (const point of model.path) {
      const p = px(point);
      ctx.beginPath();
      ctx.fillStyle = OVERLAY_LINE;
      ctx.arc(p.x, p.y, pointR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const heel = px(model.heelApex);
  const floorY = model.floorY * height;
  const x = heel.x;

  ctx.save();
  ctx.strokeStyle = OVERLAY_LINE;
  ctx.fillStyle = OVERLAY_LINE;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";

  // Vertical line: floor → heel peak
  ctx.beginPath();
  ctx.moveTo(x, floorY);
  ctx.lineTo(x, heel.y);
  ctx.stroke();

  // Short horizontal floor tick
  const tick = Math.max(10, width * 0.028);
  ctx.beginPath();
  ctx.moveTo(x - tick, floorY);
  ctx.lineTo(x + tick, floorY);
  ctx.stroke();

  // Heel apex dot
  ctx.beginPath();
  ctx.arc(heel.x, heel.y, heelR, 0, Math.PI * 2);
  ctx.fill();

  // Official flight-time height next to the line
  const tag = `${model.heightIn.toFixed(1)} in`;
  const fontPx = Math.max(14, Math.round(width * 0.045));
  ctx.font = `600 ${fontPx}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const padX = 8;
  const metrics = ctx.measureText(tag);
  const boxW = metrics.width + padX * 2;
  const boxH = Math.max(22, width * 0.055);
  let boxX = x + tick + 6;
  let boxY = (floorY + heel.y) / 2 - boxH / 2;
  if (boxX + boxW > width - 4) boxX = x - tick - 6 - boxW;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  boxY = Math.max(4, Math.min(height - boxH - 4, boxY));
  ctx.fillStyle = OVERLAY_TEXT_BACK;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = OVERLAY_TEXT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(tag, boxX + padX, boxY + boxH / 2);
  ctx.restore();

  void options.currentFrame;
}

/** Draw Jump height / Contact time / RSI strip (used by card + video end). */
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
    { label: "Jump height", value: `${metrics.heightIn.toFixed(1)} in` },
    { label: "Contact time", value: `${Math.round(metrics.gctMs)} ms` },
    { label: "RSI", value: metrics.rsi.toFixed(2) },
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

/**
 * Compose export card: video frame + overlays on top, metrics table below.
 * Returns a PNG blob.
 */
export function composeJumpCardPng(
  videoFrame: CanvasImageSource,
  frameW: number,
  frameH: number,
  model: JumpOverlayModel,
  metrics: JumpOverlayMetrics,
): Blob | null {
  const tableH = Math.max(96, Math.round(frameW * 0.18));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, frameW);
  canvas.height = Math.max(1, frameH + tableH);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#1c1914";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(videoFrame, 0, 0, frameW, frameH);
  drawFootOverlay(ctx, frameW, frameH, model, { showTags: true });
  drawMetricsStrip(ctx, 0, frameH, frameW, tableH, metrics);

  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/** Prefer mp4 for iPhone Share/Save; fall back to webm. */
export function pickRecorderMime(): { mimeType: string; ext: string } {
  const candidates = [
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
