import type { FootSample } from "./detect.ts";

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
  /** Frame of the highest hip (or foot) during flight — used for card/export seek. */
  apexFrame: number;
  /** Foot apex point (path highlight). */
  apex: FootPoint;
  takeoff: number;
  landing: number;
  heightIn: number;
  /** Hip Y at takeoff / standing (normalized). Null when pose lacked hips. */
  takeoffHipY: number | null;
  /** Hip Y at flight apex (normalized, smallest Y = highest). */
  apexHipY: number | null;
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

/** Smallest hipY (highest hip) between takeoff and landing. */
export function findHipApex(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
): { frame: number; hipY: number } | null {
  let best: { frame: number; hipY: number } | null = null;
  for (const sample of samples) {
    if (sample.frame < takeoff || sample.frame > landing) continue;
    const hipY = sample.hipY;
    if (hipY === undefined || !Number.isFinite(hipY)) continue;
    if (!best || hipY < best.hipY) best = { frame: sample.frame, hipY };
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
  const takeoffHipY =
    takeoffSample?.hipY !== undefined && Number.isFinite(takeoffSample.hipY)
      ? takeoffSample.hipY
      : null;
  const hipApex = findHipApex(samples, takeoff, landing);
  const apexHipY = hipApex?.hipY ?? null;
  // Seek/export frame follows the foot apex so the height tag sits on the feet.
  const apexFrame = apex.frame;
  const bracketX = Math.min(0.92, Math.max(0.08, apex.x + 0.12));

  return {
    path,
    apexFrame,
    apex,
    takeoff,
    landing,
    heightIn,
    takeoffHipY,
    apexHipY,
    bracketX,
  };
}

function drawHorizontalGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  y: number,
  label: string,
  fontPx: number,
): void {
  const x0 = width * 0.08;
  const x1 = width * 0.92;
  ctx.strokeStyle = "rgba(90, 90, 90, 0.55)";
  ctx.lineWidth = Math.max(1, width * 0.0025);
  ctx.setLineDash([Math.max(4, width * 0.012), Math.max(3, width * 0.008)]);
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = `600 ${fontPx}px Outfit, sans-serif`;
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText(label, x0, y - 3);
}

/** Vertical CoM span between takeoff/apex hip lines (no height tag — tag stays at feet). */
function drawHeightBracket(
  ctx: CanvasRenderingContext2D,
  width: number,
  takeoffY: number,
  apexY: number,
  bracketXNorm: number,
): void {
  const x = bracketXNorm * width;
  const top = Math.min(takeoffY, apexY);
  const bottom = Math.max(takeoffY, apexY);
  if (!(bottom - top > 4)) return;

  ctx.save();
  ctx.strokeStyle = "rgba(90, 90, 90, 0.65)";
  ctx.fillStyle = "rgba(90, 90, 90, 0.65)";
  ctx.lineWidth = Math.max(1.25, width * 0.003);

  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();

  const arm = Math.max(5, width * 0.014);
  const arrow = Math.max(4, width * 0.01);
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
  ctx.restore();
}

/** Height label at the foot apex (not hips). No stem. */
function drawFootHeightTag(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  apex: { x: number; y: number },
  heightIn: number,
): void {
  const tag = `${heightIn.toFixed(1)} in`;
  ctx.save();
  const fontPx = Math.max(14, Math.round(width * 0.045));
  ctx.font = `600 ${fontPx}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const padX = 8;
  const metrics = ctx.measureText(tag);
  const boxW = metrics.width + padX * 2;
  const boxH = Math.max(22, width * 0.055);
  let boxX = apex.x - boxW / 2;
  let boxY = apex.y - boxH - 8;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  boxY = Math.max(4, Math.min(height - boxH - 4, boxY));
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(tag, boxX + padX, boxY + boxH / 2);
  ctx.restore();
}

export function drawFootOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: JumpOverlayModel,
  options: { showTags?: boolean; currentFrame?: number | null } = {},
): void {
  const showTags = options.showTags !== false;
  const px = (p: FootPoint) => ({ x: p.x * width, y: p.y * height });

  if (model.path.length >= 2) {
    ctx.save();
    ctx.strokeStyle = "rgba(120, 120, 120, 0.75)";
    ctx.lineWidth = Math.max(1.25, width * 0.004);
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
      const r = Math.max(2.5, width * 0.006);
      ctx.beginPath();
      ctx.fillStyle = "#0b3d91";
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // CoM guides at hip height; height tag stays on the foot apex.
  if (
    model.takeoffHipY !== null &&
    model.apexHipY !== null &&
    Number.isFinite(model.takeoffHipY) &&
    Number.isFinite(model.apexHipY)
  ) {
    const takeoffY = model.takeoffHipY * height;
    const apexY = model.apexHipY * height;
    const fontPx = Math.max(11, Math.round(width * 0.028));
    drawHorizontalGuide(ctx, width, takeoffY, "takeoff", fontPx);
    drawHorizontalGuide(ctx, width, apexY, "apex", fontPx);
    drawHeightBracket(ctx, width, takeoffY, apexY, model.bracketX);
  }

  drawFootHeightTag(ctx, width, height, px(model.apex), model.heightIn);

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
