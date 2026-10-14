import type { BoxDateSeries, SessionMetric } from "./sessions.ts";

const METRIC_LABEL: Record<SessionMetric, string> = {
  heightIn: "Jump height (in)",
  gctMs: "Contact time (ms)",
  flightMs: "Flight time (ms)",
  rsi: "RSI",
};

/** Stable colors by common box heights; unknowns cycle the palette. */
const BOX_COLORS: Record<number, string> = {
  6: "#0e6b52",
  12: "#1d4ed8",
  18: "#b45309",
  24: "#9f1239",
  30: "#6d28d9",
};
const FALLBACK = ["#0f766e", "#c2410c", "#0369a1", "#a16207", "#be123c"];

export function metricLabel(metric: SessionMetric): string {
  return METRIC_LABEL[metric];
}

export function colorForBox(boxHeightIn: number, index: number): string {
  return BOX_COLORS[boxHeightIn] ?? FALLBACK[index % FALLBACK.length]!;
}

export interface ChartRender {
  svg: SVGSVGElement;
  legend: { boxHeightIn: number; color: string }[];
}

/** Date on X, session mean on Y; one colored series per box height. */
export function renderBoxChart(series: readonly BoxDateSeries[], metric: SessionMetric): ChartRender {
  const width = 320;
  const height = 200;
  const pad = { top: 14, right: 10, bottom: 36, left: 36 };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${metricLabel(metric)} by date`);
  svg.classList.add("box-chart");

  const legend = series.map((entry, index) => ({
    boxHeightIn: entry.boxHeightIn,
    color: colorForBox(entry.boxHeightIn, index),
  }));

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("x", String(width / 2));
    empty.setAttribute("y", String(height / 2));
    empty.setAttribute("text-anchor", "middle");
    empty.setAttribute("class", "chart-empty");
    empty.textContent = "Save jumps to see the chart";
    svg.append(empty);
    return { svg, legend: [] };
  }

  const days = [...new Set(allPoints.map((p) => p.day))].sort();
  const values = allPoints.map((p) => p.value);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xAt = (day: string) => {
    if (days.length === 1) return pad.left + plotW / 2;
    const i = days.indexOf(day);
    return pad.left + (i / (days.length - 1)) * plotW;
  };
  const yAt = (value: number) => pad.top + ((yMax - value) / (yMax - yMin)) * plotH;

  const axis = document.createElementNS("http://www.w3.org/2000/svg", "path");
  axis.setAttribute("d", `M ${pad.left} ${pad.top} V ${pad.top + plotH} H ${pad.left + plotW}`);
  axis.setAttribute("class", "chart-axis");
  svg.append(axis);

  const tickDays = pickDayTicks(days);
  for (const day of tickDays) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(xAt(day)));
    label.setAttribute("y", String(height - 10));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-tick");
    label.textContent = formatDayTick(day);
    svg.append(label);
  }

  for (const tick of [yMin, (yMin + yMax) / 2, yMax]) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(pad.left - 4));
    label.setAttribute("y", String(yAt(tick) + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-tick");
    label.textContent = formatTick(metric, tick);
    svg.append(label);
  }

  series.forEach((entry, index) => {
    if (entry.points.length === 0) return;
    const color = colorForBox(entry.boxHeightIn, index);
    const d = entry.points
      .map((point, i) => `${i === 0 ? "M" : "L"} ${xAt(point.day)} ${yAt(point.value)}`)
      .join(" ");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("class", "chart-line");
    svg.append(path);
    for (const point of entry.points) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(xAt(point.day)));
      dot.setAttribute("cy", String(yAt(point.value)));
      dot.setAttribute("r", "3.5");
      dot.setAttribute("fill", color);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${formatDayTick(point.day)} · ${entry.boxHeightIn} in · mean ${formatTick(metric, point.value)} · best ${formatTick(metric, point.best)}`;
      dot.append(title);
      svg.append(dot);
    }
  });

  return { svg, legend };
}

/** At most ~5 date labels so a phone chart stays readable. */
function pickDayTicks(days: readonly string[]): string[] {
  if (days.length <= 5) return [...days];
  const last = days.length - 1;
  const picks = new Set<number>([0, last, Math.round(last / 2)]);
  if (days.length > 5) {
    picks.add(Math.round(last / 4));
    picks.add(Math.round((3 * last) / 4));
  }
  return [...picks].sort((a, b) => a - b).map((i) => days[i]!);
}

function formatDayTick(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function formatTick(metric: SessionMetric, value: number): string {
  if (metric === "rsi") return value.toFixed(1);
  if (metric === "heightIn") return value.toFixed(1);
  return String(Math.round(value));
}
