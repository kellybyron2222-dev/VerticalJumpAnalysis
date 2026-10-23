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
  /** Frame of the highest foot position during flight (lowest footY). */
  apexFrame: number;
  apex: FootPoint;
  takeoff: number;
  landing: number;
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

export function buildJumpOverlayModel(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
  heightIn: number,
): JumpOverlayModel | null {
  const path = footPathDuringFlight(samples, takeoff, landing);
  const apex = findFlightApex(path);
  if (!apex) return null;
  return {
    path,
    apexFrame: apex.frame,
    apex,
    takeoff,
    landing,
    heightIn,
  };
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
    ctx.strokeStyle = "rgba(239, 227, 106, 0.95)";
    ctx.lineWidth = Math.max(2, width * 0.006);
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
      const r = Math.max(3, width * 0.008);
      ctx.beginPath();
      ctx.fillStyle = "rgba(14, 107, 82, 0.9)";
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Apex tag with jump height
  const apex = px(model.apex);
  const tag = `${model.heightIn.toFixed(1)} in`;
  ctx.save();
  ctx.font = `600 ${Math.max(14, Math.round(width * 0.045))}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const padX = 8;
  const metrics = ctx.measureText(tag);
  const boxW = metrics.width + padX * 2;
  const boxH = Math.max(22, width * 0.055);
  let boxX = apex.x - boxW / 2;
  let boxY = apex.y - boxH - 12;
  boxX = Math.max(4, Math.min(width - boxW - 4, boxX));
  boxY = Math.max(4, boxY);
  ctx.fillStyle = "rgba(28, 25, 20, 0.82)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "#efe36a";
  ctx.textBaseline = "middle";
  ctx.fillText(tag, boxX + padX, boxY + boxH / 2);
  // Stem to apex
  ctx.strokeStyle = "rgba(239, 227, 106, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(apex.x, boxY + boxH);
  ctx.lineTo(apex.x, apex.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = "#efe36a";
  ctx.arc(apex.x, apex.y, Math.max(4, width * 0.01), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  void options.currentFrame;
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

  // Metrics table under the frame
  const y0 = frameH;
  ctx.fillStyle = "#f3f0e7";
  ctx.fillRect(0, y0, frameW, tableH);
  ctx.strokeStyle = "#e2dccf";
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(frameW, y0);
  ctx.stroke();

  const cols = [
    { label: "Jump height", value: `${metrics.heightIn.toFixed(1)} in` },
    { label: "Contact time", value: `${Math.round(metrics.gctMs)} ms` },
    { label: "RSI", value: metrics.rsi.toFixed(2) },
  ];
  const colW = frameW / 3;
  cols.forEach((col, i) => {
    const cx = colW * i + colW / 2;
    ctx.fillStyle = "#6d675c";
    ctx.font = `600 ${Math.max(11, Math.round(frameW * 0.028))}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(col.label, cx, y0 + tableH * 0.38);
    ctx.fillStyle = "#1c1914";
    ctx.font = `600 ${Math.max(18, Math.round(frameW * 0.055))}px "Barlow Condensed", sans-serif`;
    ctx.fillText(col.value, cx, y0 + tableH * 0.72);
    if (i > 0) {
      ctx.strokeStyle = "#e2dccf";
      ctx.beginPath();
      ctx.moveTo(colW * i, y0 + 12);
      ctx.lineTo(colW * i, y0 + tableH - 12);
      ctx.stroke();
    }
  });

  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}
