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
  /** Frame of the highest foot during flight — used for card/export seek. */
  apexFrame: number;
  /** Foot apex point (path highlight). */
  apex: FootPoint;
  takeoff: number;
  landing: number;
  /** Official flight-time jump height (in); label only — not scaled from pixels. */
  heightIn: number;
  /** Foot Y at takeoff / floor / toe-off (normalized). */
  takeoffFootY: number;
  /** Foot Y at peak height during flight (normalized, smallest Y = highest). */
  apexFootY: number;
  /** X for the height bracket (0–1). */
  bracketX: number;
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

function sampleNear(
  samples: readonly FootSample[],
  frame: number,
): FootSample | null {
  let best: FootSample | null = null;
  let bestDist = Infinity;
  for (const sample of samples) {
    const dist = Math.abs(sample.frame - frame);
    if (dist < bestDist) {
      best = sample;
      bestDist = dist;
    }
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
  const apex = findFlightApex(path);
  if (!apex) return null;

  const takeoffSample = sampleNear(samples, takeoff);
  const takeoffFootY =
    takeoffSample !== null && Number.isFinite(takeoffSample.footY)
      ? takeoffSample.footY
      : path[0]!.y;

  const bracketX = Math.min(0.92, Math.max(0.08, apex.x + 0.12));

  return {
    path,
    apexFrame: apex.frame,
    apex,
    takeoff,
    landing,
    heightIn,
    takeoffFootY,
    apexFootY: apex.y,
    bracketX,
  };
}

function drawLabeledGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  y: number,
  label: string,
  fontPx: number,
  lineWidth: number,
): void {
  const x0 = width * 0.08;
  const x1 = width * 0.92;
  ctx.strokeStyle = OVERLAY_LINE;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([Math.max(5, width * 0.014), Math.max(4, width * 0.01)]);
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `600 ${fontPx}px Outfit, sans-serif`;
  const padX = 5;
  const padY = 2;
  const tw = ctx.measureText(label).width;
  const boxH = fontPx + padY * 2;
  const boxW = tw + padX * 2;
  const boxX = x0;
  const boxY = y - boxH - 3;
  ctx.fillStyle = OVERLAY_TEXT_BACK;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = OVERLAY_TEXT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, boxX + padX, boxY + boxH / 2);
}

/** Vertical span between foot takeoff/apex lines; label = official flight-time height. */
function drawHeightBracket(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  takeoffY: number,
  apexY: number,
  bracketXNorm: number,
  heightIn: number,
): void {
  const x = bracketXNorm * width;
  const top = Math.min(takeoffY, apexY);
  const bottom = Math.max(takeoffY, apexY);
  if (!(bottom - top > 4)) return;

  ctx.save();
  ctx.strokeStyle = OVERLAY_LINE;
  ctx.fillStyle = OVERLAY_LINE;
  ctx.lineWidth = Math.max(1.9, width * 0.0045);

  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();

  const arm = Math.max(7, width * 0.02);
  const arrow = Math.max(6, width * 0.014);
  for (const y of [top, bottom]) {
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x - arrow * 0.6, top + arrow);
  ctx.lineTo(x + arrow * 0.6, top + arrow);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, bottom);
  ctx.lineTo(x - arrow * 0.6, bottom - arrow);
  ctx.lineTo(x + arrow * 0.6, bottom - arrow);
  ctx.closePath();
  ctx.fill();

  const tag = `${heightIn.toFixed(1)} in`;
  const fontPx = Math.max(14, Math.round(width * 0.045));
  ctx.font = `600 ${fontPx}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const padX = 8;
  const metrics = ctx.measureText(tag);
  const boxW = metrics.width + padX * 2;
  const boxH = Math.max(22, width * 0.055);
  let boxX = x + arm + 6;
  let boxY = (top + bottom) / 2 - boxH / 2;
  if (boxX + boxW > width - 4) boxX = x - arm - 6 - boxW;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  boxY = Math.max(4, Math.min(height - boxH - 4, boxY));

  ctx.fillStyle = OVERLAY_TEXT_BACK;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = OVERLAY_TEXT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(tag, boxX + padX, boxY + boxH / 2);
  ctx.restore();
}

/**
 * Draw foot path + foot-level takeoff/apex guides + height bracket.
 * Single code path for on-screen overlay, PNG jump card, and video export.
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
  const guideWidth = Math.max(1.5, width * 0.00375);
  const pointR = Math.max(3.5, width * 0.009);

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

  // Foot-based visual guide (floor/toe-off → foot peak). Label = official flight-time height.
  if (Number.isFinite(model.takeoffFootY) && Number.isFinite(model.apexFootY)) {
    const takeoffY = model.takeoffFootY * height;
    const apexY = model.apexFootY * height;
    const fontPx = Math.max(11, Math.round(width * 0.028));
    drawLabeledGuide(ctx, width, takeoffY, "takeoff", fontPx, guideWidth);
    drawLabeledGuide(ctx, width, apexY, "apex", fontPx, guideWidth);
    drawHeightBracket(
      ctx,
      width,
      height,
      takeoffY,
      apexY,
      model.bracketX,
      model.heightIn,
    );
  }

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
