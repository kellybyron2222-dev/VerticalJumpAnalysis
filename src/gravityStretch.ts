import type { FootSample } from "./detect.ts";
import { isVariableRate, measuredFps, type SloMoHint } from "./timing.ts";

const G = 9.80665;
const REF_LEG_M = 0.7;

export function isAmbiguousSloMo(
  times: readonly number[] | null | undefined,
  hint: SloMoHint,
): boolean {
  if (!times || times.length < 10) return false;
  if (hint.slowMoPlayback !== true) return false;
  if (isVariableRate(times)) return false;
  const fps = measuredFps(times);
  return fps !== null && fps >= 24 && fps <= 36;
}

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function quantile(v: number[], q: number): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export function gravityStretch(
  samples: readonly FootSample[],
  takeoff: number,
  landing: number,
  frameTimes: readonly number[],
  candidates: readonly number[] = [4, 8],
): { stretch: number; legM: Record<number, number> } | null {
  const span = landing - takeoff;
  if (!(span > 6)) return null;
  const lo = takeoff + span * 0.15,
    hi = landing - span * 0.15;
  const byFrame = new Map<number, FootSample>();
  for (const s of samples) if (s.hipY !== undefined) byFrame.set(Math.round(s.frame), s);
  const pts: Array<[number, number]> = [];
  for (const [f, s] of byFrame)
    if (f >= lo && f <= hi && f < frameTimes.length) pts.push([frameTimes[f]!, s.hipY!]);
  if (pts.length < 6) return null;
  const tm = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    y0 = 0,
    y1 = 0,
    y2 = 0;
  for (const [t0, y] of pts) {
    const t = t0 - tm;
    s0 += 1;
    s1 += t;
    s2 += t * t;
    s3 += t ** 3;
    s4 += t ** 4;
    y0 += y;
    y1 += y * t;
    y2 += y * t * t;
  }
  const det = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det([
    [s4, s3, s2],
    [s3, s2, s1],
    [s2, s1, s0],
  ]);
  if (!(Math.abs(D) > 1e-12)) return null;
  const a =
    det([
      [y2, s3, s2],
      [y1, s2, s1],
      [y0, s1, s0],
    ]) / D;
  if (!(a > 0)) return null;
  const legs: number[] = [];
  for (const [f, s] of byFrame) {
    if (f >= takeoff - 2 && f <= landing + 2) continue;
    const d = s.footY - s.hipY!;
    if (d > 0.02) legs.push(d);
  }
  const leg = quantile(legs, 0.75) ?? median(legs);
  if (leg === null || legs.length < 4) return null;
  const legM: Record<number, number> = {};
  let best: number | null = null;
  let bestErr = Infinity;
  for (const k of candidates) {
    const unitsPerM = (2 * a * k * k) / G;
    const L = leg / unitsPerM;
    legM[k] = L;
    const err = Math.abs(Math.log(L / REF_LEG_M));
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  return best === null ? null : { stretch: best, legM };
}
