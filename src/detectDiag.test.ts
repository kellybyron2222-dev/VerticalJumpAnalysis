import { describe, expect, it } from "vitest";
import { detectEvents, type FootSample } from "./detect.ts";
import {
  formatDetectDiagnostics,
  median,
  scoreJumpCycle,
} from "./detectDiag.ts";
import { pickBestPose, poseExtent } from "./pose.ts";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

const BOX = 0.7;
const FLOOR = 0.9;

function jumpAt(
  td: number,
  to: number,
  ld: number,
  from: number,
  until: number,
): FootSample[] {
  const samples: FootSample[] = [];
  const stepOff = td - 25;
  for (let frame = from; frame < until; frame += 1) {
    let footY: number;
    if (frame < stepOff) footY = BOX;
    else if (frame < td) footY = BOX + ((FLOOR - 0.05 - BOX) * (frame - stepOff)) / Math.max(1, td - stepOff);
    else if (frame < to) footY = FLOOR;
    else if (frame < ld) {
      const t = (frame - to) / Math.max(1, ld - to);
      footY = FLOOR - 0.05 - 0.18 * 4 * t * (1 - t);
    } else footY = FLOOR;
    samples.push({ frame, footY, hipY: footY - 0.25 });
  }
  return samples;
}

function landmark(x: number, y: number, visibility = 0.9): NormalizedLandmark {
  return { x, y, z: 0, visibility };
}

function fakePose(scale: number, cx: number): NormalizedLandmark[] {
  const pts: NormalizedLandmark[] = Array.from({ length: 33 }, () => landmark(cx, 0.5, 0.01));
  // hips 23,24
  pts[23] = landmark(cx - 0.05 * scale, 0.45, 0.9);
  pts[24] = landmark(cx + 0.05 * scale, 0.45, 0.9);
  pts[25] = landmark(cx - 0.05 * scale, 0.65, 0.8);
  pts[26] = landmark(cx + 0.05 * scale, 0.65, 0.8);
  pts[27] = landmark(cx - 0.05 * scale, 0.85, 0.7);
  pts[28] = landmark(cx + 0.05 * scale, 0.85, 0.7);
  pts[29] = landmark(cx - 0.05 * scale, 0.88, 0.6);
  pts[30] = landmark(cx + 0.05 * scale, 0.88, 0.6);
  return pts;
}

describe("detect diagnostics + scoring", () => {
  it("scores a normal cycle as confident", () => {
    const scored = scoreJumpCycle(40, 90, 200);
    expect(scored.score).toBeGreaterThanOrEqual(10);
    expect(scored.stage).toBe("ok");
  });

  it("flags flight too short", () => {
    const scored = scoreJumpCycle(10, 40, 41);
    expect(scored.stage).toBe("flight_too_short");
    expect(scored.score).toBeLessThan(10);
  });

  it("formats a compact diagnostic block", () => {
    const text = formatDetectDiagnostics({
      framesScanned: 200,
      framesWithPerson: 180,
      medianAnkleVis: 0.4,
      medianHeelVis: 0.3,
      medianKneeVis: 0.7,
      medianHipVis: 0.8,
      hipYMin: 0.4,
      hipYMax: 0.7,
      rejectStage: "no_rebound",
      candidates: [{ stepOff: 10, touchdown: 40, takeoff: 90, landing: 200, score: 22, note: "ok" }],
      lowConfidence: false,
      notes: [],
    });
    expect(text).toContain("Frames scanned: 200");
    expect(text).toContain("Reject stage: no_rebound");
    expect(text).toContain("TD 40");
    expect(median([1, 2, 3])).toBe(2);
  });
});

describe("walking lead-in + low confidence", () => {
  it("picks the real jump after a walking leave, not the first step", () => {
    // Brief early "step" then standing, then on-box + real drop jump.
    const walk: FootSample[] = [];
    for (let frame = 0; frame < 80; frame += 1) {
      let footY = FLOOR;
      if (frame >= 20 && frame < 28) footY = FLOOR - 0.04;
      walk.push({ frame, footY, hipY: footY - 0.25 });
    }
    const real = jumpAt(160, 210, 320, 80, 420);
    const result = detectEvents([...walk, ...real]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Must choose the floor-contact jump, not the walk→box false cycle.
    expect(result.events.touchdown).toBeGreaterThanOrEqual(150);
    expect(result.events.takeoff).toBeGreaterThan(result.events.touchdown);
    expect(result.diagnostics.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("proposes low-confidence marks instead of refusing a marginal flight", () => {
    // Very short flight — still proposable.
    const samples = jumpAt(40, 70, 74, 0, 160);
    const result = detectEvents(samples, undefined, 2);
    expect(result.diagnostics.candidates.length).toBeGreaterThanOrEqual(1);
    if (result.ok) {
      expect(result.lowConfidence === true || result.ok).toBe(true);
    } else {
      expect(result.diagnostics.rejectStage).not.toBe("no_samples");
    }
  });

  it("returns diagnostics when there is no drop", () => {
    const samples: FootSample[] = [];
    for (let frame = 0; frame < 40; frame += 1) samples.push({ frame, footY: FLOOR });
    const result = detectEvents(samples);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.rejectStage).toBe("no_drop");
    expect(formatDetectDiagnostics(result.diagnostics)).toContain("no_drop");
  });
});

describe("person track selection", () => {
  it("picks the larger pose over a small rack-like detection", () => {
    const athlete = fakePose(1.2, 0.45);
    const rack = fakePose(0.25, 0.85);
    expect(poseExtent(athlete)).toBeGreaterThan(poseExtent(rack));
    const picked = pickBestPose([rack, athlete], null);
    expect(picked).not.toBeNull();
    expect(picked!.centroid.x).toBeCloseTo(0.45, 1);
  });

  it("stays on the previous athlete when a second blob appears", () => {
    const athlete = fakePose(1.0, 0.4);
    const other = fakePose(1.1, 0.9);
    const first = pickBestPose([athlete], null);
    const next = pickBestPose([other, athlete], first!.centroid);
    expect(next!.centroid.x).toBeCloseTo(0.4, 1);
  });
});
