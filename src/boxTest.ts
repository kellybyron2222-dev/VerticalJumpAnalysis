import { DEFAULT_CV } from "./baseline.ts";
import type { JumpType, KeyValueStore, TrialRecord } from "./storage.ts";
import { trialDay } from "./sessions.ts";

export const DEFAULT_BOX_TEST_HEIGHTS = [6, 12, 18, 24] as const;
export const BOX_TEST_HEIGHT_CHOICES = [6, 12, 18, 24, 30] as const;
export const WORKING_BOX_STORAGE_KEY = "jumpLab.workingBox.v1";
export const ACTIVE_BOX_TEST_KEY = "jumpLab.activeBoxTest.v1";

export interface BoxTestHeightSummary {
  boxHeightIn: number;
  count: number;
  meanRsi: number;
  meanGctMs: number;
}

export interface BoxTestRecommendation {
  /** Winning height, or lowest tested when none meet the contact target. */
  recommendedBoxIn: number;
  /** True when at least one height had mean GCT ≤ target. */
  meetsTarget: boolean;
  message: string;
  summaries: BoxTestHeightSummary[];
}

export interface ActiveBoxTest {
  id: string;
  jumpType: JumpType;
  heights: number[];
  startedAt: string;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function createBoxTestId(now = new Date()): string {
  return `boxtest-${now.toISOString()}`;
}

export function normalizeBoxTestHeights(heights: readonly number[]): number[] | null {
  const unique = [...new Set(heights.filter((h) => Number.isFinite(h) && h > 0))].sort(
    (a, b) => a - b,
  );
  if (unique.length < 3 || unique.length > 5) return null;
  return unique;
}

export function startBoxTest(
  jumpType: JumpType,
  heights: readonly number[],
  now = new Date(),
): ActiveBoxTest | null {
  const normalized = normalizeBoxTestHeights(heights);
  if (!normalized) return null;
  if (jumpType !== "drop" && jumpType !== "depth") return null;
  return {
    id: createBoxTestId(now),
    jumpType,
    heights: normalized,
    startedAt: now.toISOString(),
  };
}

export function loadActiveBoxTest(storage: KeyValueStore): ActiveBoxTest | null {
  try {
    const raw = storage.getItem(ACTIVE_BOX_TEST_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<ActiveBoxTest>;
    if (
      typeof data.id !== "string" ||
      (data.jumpType !== "drop" && data.jumpType !== "depth") ||
      !Array.isArray(data.heights) ||
      typeof data.startedAt !== "string"
    ) {
      return null;
    }
    const heights = normalizeBoxTestHeights(data.heights.map(Number));
    if (!heights) return null;
    return { id: data.id, jumpType: data.jumpType, heights, startedAt: data.startedAt };
  } catch {
    return null;
  }
}

export function saveActiveBoxTest(storage: KeyValueStore, test: ActiveBoxTest | null): boolean {
  try {
    if (!test) {
      storage.setItem(ACTIVE_BOX_TEST_KEY, "");
      return true;
    }
    storage.setItem(ACTIVE_BOX_TEST_KEY, JSON.stringify(test));
    return true;
  } catch {
    return false;
  }
}

export function loadWorkingBox(
  storage: KeyValueStore,
  jumpType: JumpType,
): number | null {
  try {
    const raw = storage.getItem(WORKING_BOX_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const value = data[jumpType];
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveWorkingBox(
  storage: KeyValueStore,
  jumpType: JumpType,
  boxHeightIn: number,
): boolean {
  if (!(boxHeightIn > 0)) return false;
  try {
    const raw = storage.getItem(WORKING_BOX_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    data[jumpType] = boxHeightIn;
    storage.setItem(WORKING_BOX_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function trialsForBoxTest(
  trials: readonly TrialRecord[],
  testId: string,
): TrialRecord[] {
  return trials.filter((trial) => trial.boxTestId === testId);
}

/** Mean RSI / GCT per box height for one tagged test. */
export function summarizeBoxTest(
  trials: readonly TrialRecord[],
  testId: string,
  heights?: readonly number[],
): BoxTestHeightSummary[] {
  const tagged = trialsForBoxTest(trials, testId);
  const boxes = heights ?? [...new Set(tagged.map((t) => t.boxHeightIn))].sort((a, b) => a - b);
  return boxes.map((boxHeightIn) => {
    const atBox = tagged.filter((t) => t.boxHeightIn === boxHeightIn);
    return {
      boxHeightIn,
      count: atBox.length,
      meanRsi: mean(atBox.map((t) => t.rsi)),
      meanGctMs: mean(atBox.map((t) => t.gctMs)),
    };
  });
}

/**
 * Highest mean RSI among heights with mean GCT ≤ target.
 * If two are within 1× CV of each other on RSI, pick the lower box.
 * If none meet the target, recommend the lowest tested height.
 */
export function recommendBoxHeight(
  summaries: readonly BoxTestHeightSummary[],
  gctTargetMs: number,
  cv: number = DEFAULT_CV,
): BoxTestRecommendation | null {
  const tested = summaries.filter((s) => s.count > 0);
  if (tested.length === 0) return null;

  const eligible = tested.filter((s) => s.meanGctMs <= gctTargetMs);
  if (eligible.length === 0) {
    const lowest = [...tested].sort((a, b) => a.boxHeightIn - b.boxHeightIn)[0]!;
    return {
      recommendedBoxIn: lowest.boxHeightIn,
      meetsTarget: false,
      message: `No height met contact ≤ ${gctTargetMs} ms — use lowest (${lowest.boxHeightIn} in)`,
      summaries: [...tested].sort((a, b) => a.boxHeightIn - b.boxHeightIn),
    };
  }

  const ranked = [...eligible].sort((a, b) => b.meanRsi - a.meanRsi);
  const top = ranked[0]!;
  // Among heights within 1× CV of the best RSI, prefer the lower box.
  const near = eligible.filter((s) => {
    const denom = Math.max(top.meanRsi, s.meanRsi, 1e-9);
    return Math.abs(top.meanRsi - s.meanRsi) / denom <= cv;
  });
  const best = near.reduce((a, b) => (a.boxHeightIn <= b.boxHeightIn ? a : b));

  return {
    recommendedBoxIn: best.boxHeightIn,
    meetsTarget: true,
    message: `Recommended working box · ${best.boxHeightIn} in (highest RSI with contact ≤ ${gctTargetMs} ms)`,
    summaries: [...tested].sort((a, b) => a.boxHeightIn - b.boxHeightIn),
  };
}

/** Days that completed a box test with 3+ distinct heights (for raiseBox retest). */
export function boxTestProfileDays(trials: readonly TrialRecord[]): string[] {
  const byTest = new Map<string, { day: string; boxes: Set<number> }>();
  for (const trial of trials) {
    if (!trial.boxTestId) continue;
    const day = trialDay(trial.createdAt);
    const entry = byTest.get(trial.boxTestId) ?? { day, boxes: new Set<number>() };
    entry.boxes.add(trial.boxHeightIn);
    byTest.set(trial.boxTestId, entry);
  }
  return [...byTest.values()]
    .filter((entry) => entry.boxes.size >= 3)
    .map((entry) => entry.day)
    .sort();
}

/** Plain SVG: RSI (left) and contact ms (right) by box height for one test. */
export function renderBoxTestChart(summaries: readonly BoxTestHeightSummary[]): SVGSVGElement {
  const width = 320;
  const height = 180;
  const pad = { top: 14, right: 36, bottom: 28, left: 36 };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Box test RSI and contact by height");
  svg.classList.add("box-chart");

  const tested = summaries.filter((s) => s.count > 0);
  if (tested.length === 0) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("x", String(width / 2));
    empty.setAttribute("y", String(height / 2));
    empty.setAttribute("text-anchor", "middle");
    empty.setAttribute("class", "chart-empty");
    empty.textContent = "Save test jumps to see results";
    svg.append(empty);
    return svg;
  }

  const boxes = tested.map((s) => s.boxHeightIn);
  let rsiMin = Math.min(...tested.map((s) => s.meanRsi));
  let rsiMax = Math.max(...tested.map((s) => s.meanRsi));
  let gctMin = Math.min(...tested.map((s) => s.meanGctMs));
  let gctMax = Math.max(...tested.map((s) => s.meanGctMs));
  if (rsiMin === rsiMax) {
    rsiMin -= 0.1;
    rsiMax += 0.1;
  }
  if (gctMin === gctMax) {
    gctMin -= 10;
    gctMax += 10;
  }
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xAt = (box: number) => {
    if (boxes.length === 1) return pad.left + plotW / 2;
    const i = boxes.indexOf(box);
    return pad.left + (i / (boxes.length - 1)) * plotW;
  };
  const yRsi = (v: number) => pad.top + ((rsiMax - v) / (rsiMax - rsiMin)) * plotH;
  const yGct = (v: number) => pad.top + ((gctMax - v) / (gctMax - gctMin)) * plotH;

  const axis = document.createElementNS("http://www.w3.org/2000/svg", "path");
  axis.setAttribute("d", `M ${pad.left} ${pad.top} V ${pad.top + plotH} H ${pad.left + plotW}`);
  axis.setAttribute("class", "chart-axis");
  svg.append(axis);

  for (const box of boxes) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(xAt(box)));
    label.setAttribute("y", String(height - 8));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-tick");
    label.textContent = String(box);
    svg.append(label);
  }

  const rsiPath = tested
    .map((s, i) => `${i === 0 ? "M" : "L"} ${xAt(s.boxHeightIn)} ${yRsi(s.meanRsi)}`)
    .join(" ");
  const gctPath = tested
    .map((s, i) => `${i === 0 ? "M" : "L"} ${xAt(s.boxHeightIn)} ${yGct(s.meanGctMs)}`)
    .join(" ");
  for (const [d, color] of [
    [rsiPath, "#0e6b52"],
    [gctPath, "#c6531a"],
  ] as const) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    svg.append(path);
  }
  for (const s of tested) {
    for (const [y, color] of [
      [yRsi(s.meanRsi), "#0e6b52"],
      [yGct(s.meanGctMs), "#c6531a"],
    ] as const) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(xAt(s.boxHeightIn)));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", "3.5");
      dot.setAttribute("fill", color);
      svg.append(dot);
    }
  }
  return svg;
}
