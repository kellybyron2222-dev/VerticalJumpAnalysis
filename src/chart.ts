import type { BoxProfileSeries, SessionMetric } from "./sessions.ts";

const METRIC_LABEL: Record<SessionMetric, string> = {
  heightIn: "Jump height (in)",
  gctMs: "Contact time (ms)",
  flightMs: "Flight time (ms)",
  rsi: "RSI",
};

export function metricLabel(metric: SessionMetric): string {
  return METRIC_LABEL[metric];
}

/** Plain SVG line chart: box height on X, metric mean on Y. One path per week series. */
export function renderBoxChart(series: readonly BoxProfileSeries[], metric: SessionMetric): SVGSVGElement {
  const width = 320;
  const height = 180;
  const pad = { top: 16, right: 12, bottom: 28, left: 36 };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${metricLabel(metric)} by box height`);
  svg.classList.add("box-chart");

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "text");
    empty.setAttribute("x", String(width / 2));
    empty.setAttribute("y", String(height / 2));
    empty.setAttribute("text-anchor", "middle");
    empty.setAttribute("class", "chart-empty");
    empty.textContent = "Save jumps to see the box chart";
    svg.append(empty);
    return svg;
  }

  const boxes = [...new Set(allPoints.map((p) => p.boxHeightIn))].sort((a, b) => a - b);
  const values = allPoints.map((p) => p.value);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xAt = (box: number) => {
    if (boxes.length === 1) return pad.left + plotW / 2;
    const i = boxes.indexOf(box);
    return pad.left + (i / (boxes.length - 1)) * plotW;
  };
  const yAt = (value: number) => pad.top + ((yMax - value) / (yMax - yMin)) * plotH;

  // Axes
  const axis = document.createElementNS("http://www.w3.org/2000/svg", "path");
  axis.setAttribute(
    "d",
    `M ${pad.left} ${pad.top} V ${pad.top + plotH} H ${pad.left + plotW}`,
  );
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

  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  for (const tick of yTicks) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(pad.left - 4));
    label.setAttribute("y", String(yAt(tick) + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-tick");
    label.textContent = formatTick(metric, tick);
    svg.append(label);
  }

  const colors = ["#1f4b3a", "#b45309", "#1d4ed8", "#9f1239"];
  series.forEach((entry, index) => {
    if (entry.points.length === 0) return;
    const color = colors[index % colors.length]!;
    const d = entry.points
      .map((point, i) => `${i === 0 ? "M" : "L"} ${xAt(point.boxHeightIn)} ${yAt(point.value)}`)
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
      dot.setAttribute("cx", String(xAt(point.boxHeightIn)));
      dot.setAttribute("cy", String(yAt(point.value)));
      dot.setAttribute("r", "3.5");
      dot.setAttribute("fill", color);
      svg.append(dot);
    }
  });

  return svg;
}

function formatTick(metric: SessionMetric, value: number): string {
  if (metric === "rsi") return value.toFixed(1);
  if (metric === "heightIn") return value.toFixed(1);
  return String(Math.round(value));
}
