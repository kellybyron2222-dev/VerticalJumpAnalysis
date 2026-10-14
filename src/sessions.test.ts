import { describe, expect, it } from "vitest";
import {
  bestOf,
  boxProfileByWeek,
  groupSessions,
  sessionsForDay,
  trialDay,
  weekKey,
} from "./sessions.ts";
import type { TrialRecord } from "./storage.ts";

function jump(partial: Partial<TrialRecord> & Pick<TrialRecord, "id" | "createdAt" | "jumpType" | "boxHeightIn">): TrialRecord {
  return {
    fps: 170,
    armSwing: false,
    notes: "",
    touchdownFrame: 10,
    takeoffFrame: 50,
    landingFrame: 140,
    gctMs: 220,
    flightMs: 500,
    heightM: 0.3,
    heightIn: 12,
    heightCm: 30,
    rsi: 1.4,
    ...partial,
  };
}

describe("session grouping", () => {
  it("groups by local day, jump type, and box height", () => {
    const trials = [
      jump({ id: "a", createdAt: "2026-10-14T10:00:00", jumpType: "drop", boxHeightIn: 12, heightIn: 14, gctMs: 200, rsi: 1.6 }),
      jump({ id: "b", createdAt: "2026-10-14T11:00:00", jumpType: "drop", boxHeightIn: 12, heightIn: 12, gctMs: 240, rsi: 1.2 }),
      jump({ id: "c", createdAt: "2026-10-14T12:00:00", jumpType: "drop", boxHeightIn: 18, heightIn: 13, gctMs: 230, rsi: 1.3 }),
      jump({ id: "d", createdAt: "2026-10-13T09:00:00", jumpType: "depth", boxHeightIn: 12, heightIn: 11, gctMs: 250, rsi: 1.1 }),
    ];
    const groups = groupSessions(trials);
    expect(groups).toHaveLength(3);
    const todayDrop12 = groups.find((g) => g.day === trialDay("2026-10-14T10:00:00") && g.boxHeightIn === 12);
    expect(todayDrop12?.count).toBe(2);
    expect(todayDrop12?.mean.heightIn).toBeCloseTo(13, 5);
    expect(todayDrop12?.mean.gctMs).toBeCloseTo(220, 5);
    expect(todayDrop12?.best.heightIn).toBe(14);
    expect(todayDrop12?.best.gctMs).toBe(200);
    expect(todayDrop12?.best.rsi).toBe(1.6);
  });

  it("filters today's session groups", () => {
    const day = trialDay("2026-10-14T15:00:00");
    const trials = [
      jump({ id: "a", createdAt: "2026-10-14T15:00:00", jumpType: "drop", boxHeightIn: 6 }),
      jump({ id: "b", createdAt: "2026-10-13T15:00:00", jumpType: "drop", boxHeightIn: 6 }),
    ];
    expect(sessionsForDay(trials, day)).toHaveLength(1);
    expect(sessionsForDay(trials, day)[0]!.count).toBe(1);
  });

  it("treats lower contact time as best", () => {
    expect(bestOf("gctMs", [250, 200, 220])).toBe(200);
    expect(bestOf("heightIn", [10, 14, 12])).toBe(14);
  });
});

describe("box profile by week", () => {
  it("builds one series per week with means by box", () => {
    // Same ISO week (Mon start): Oct 13–14 2026.
    const trials = [
      jump({ id: "a", createdAt: "2026-10-13T10:00:00", jumpType: "drop", boxHeightIn: 6, heightIn: 10 }),
      jump({ id: "b", createdAt: "2026-10-13T11:00:00", jumpType: "drop", boxHeightIn: 12, heightIn: 12 }),
      jump({ id: "c", createdAt: "2026-10-14T10:00:00", jumpType: "drop", boxHeightIn: 6, heightIn: 14 }),
      jump({ id: "d", createdAt: "2026-10-14T11:00:00", jumpType: "depth", boxHeightIn: 6, heightIn: 11 }),
    ];
    const drop = boxProfileByWeek(trials, "heightIn", "drop");
    expect(drop).toHaveLength(1);
    expect(drop[0]!.label).toBe(weekKey(trialDay("2026-10-13T10:00:00")));
    expect(drop[0]!.points.map((p) => p.boxHeightIn)).toEqual([6, 12]);
    // Box 6: mean of Mon session (10) and Tue session (14) → 12
    expect(drop[0]!.points[0]!.value).toBeCloseTo(12, 5);
    expect(drop[0]!.points[1]!.value).toBeCloseTo(12, 5);
  });
});
