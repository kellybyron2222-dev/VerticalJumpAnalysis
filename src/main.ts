import "@fontsource/outfit/latin-400.css";
import "@fontsource/outfit/latin-500.css";
import "@fontsource/outfit/latin-600.css";
import "@fontsource/barlow-condensed/latin-500.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./style.css";
import {
  formatArmSwing,
  formatBoxInches,
  formatClock,
  formatHeightCm,
  formatHeightIn,
  formatInValue,
  formatJumpType,
  formatMilliseconds,
  formatMsValue,
  formatRsi,
} from "./format.ts";
import { trialFormError } from "./form.ts";
import { collectFrameTimes, transportEnabledAfterClockRead } from "./cadence.ts";
import { parseMovClip } from "./mov.ts";
import { analyzeClip } from "./pose.ts";
import { previewMetrics, realSecondsOnClock } from "./metrics.ts";
import { FrameSeeker, clampFrame } from "./seek.ts";
import {
  captureFps,
  estimateBoxHeight,
  isVariableRate,
  measuredFps,
  metricStretch,
  sanityWarnings,
  sloMoStretch,
  stepOffForFall,
} from "./timing.ts";
import {
  createTrial,
  loadTrials,
  saveTrials,
  type JumpType,
  type TrialRecord,
} from "./storage.ts";
import { boxProfileByWeek, sessionsForDay, type SessionMetric } from "./sessions.ts";
import { metricLabel, renderBoxChart } from "./chart.ts";

const guide = must<HTMLElement>("#guide");
const analyze = must<HTMLElement>("#analyze");
const menuButton = must<HTMLButtonElement>("#menu-button");
const menuPanel = must<HTMLElement>("#menu-panel");
const videoInput = must<HTMLInputElement>("#video-input");
const video = must<HTMLVideoElement>("#video");
const videoStatus = must<HTMLElement>("#video-status");
const emptyVideo = must<HTMLElement>("#empty-video");
const player = must<HTMLElement>("#player");
const clipName = must<HTMLElement>("#clip-name");
const frameLabel = must<HTMLElement>("#frame-label");
const totalLabel = must<HTMLElement>("#total-label");
const timeLabel = must<HTMLElement>("#time-label");
const fpsInput = must<HTMLInputElement>("#fps");
const scrubber = must<HTMLInputElement>("#scrubber");
const stepButtons = [...document.querySelectorAll<HTMLButtonElement>(".transport button")];
const jumpForm = must<HTMLFormElement>("#jump-form");
const boxInput = must<HTMLInputElement>("#box-height");
const notesInput = must<HTMLTextAreaElement>("#notes");
const metricsHint = must<HTMLElement>("#metrics-hint");
const metricsValues = must<HTMLElement>("#metrics-values");
const formError = must<HTMLElement>("#form-error");
const saveStatus = must<HTMLElement>("#save-status");
const savedCount = must<HTMLElement>("#saved-count");
const savedEmpty = must<HTMLElement>("#saved-empty");
const jumpList = must<HTMLUListElement>("#jump-list");
const sessionEmpty = must<HTMLElement>("#session-empty");
const sessionList = must<HTMLUListElement>("#session-list");
const chartRoot = must<HTMLElement>("#chart-root");
const chartLegend = must<HTMLElement>("#chart-legend");
const chartMetric = must<HTMLSelectElement>("#chart-metric");
const chartJumpType = must<HTMLSelectElement>("#chart-jump-type");
const autoButton = must<HTMLButtonElement>("#auto-detect");
const cancelDetect = must<HTMLButtonElement>("#cancel-detect");
const detectStatus = must<HTMLElement>("#detect-status");
const slowInput = must<HTMLInputElement>("#slowmo");
const cadenceButton = must<HTMLButtonElement>("#detect-cadence");
const cadenceStatus = must<HTMLElement>("#cadence-status");
const timingReadout = must<HTMLElement>("#timing-readout");
const boxEstimate = must<HTMLElement>("#box-estimate");
const metricsWarning = must<HTMLElement>("#metrics-warning");

video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("webkit-playsinline", "");
video.muted = true;
video.controls = false;

const seeker = new FrameSeeker(video, readFps() ?? 240);

const marks = {
  stepOff: null as number | null,
  touchdown: null as number | null,
  takeoff: null as number | null,
  landing: null as number | null,
};

let frame = 0;
let ready = false;
let objectUrl: string | null = null;
let pendingDeleteId: string | null = null;
let detecting: AbortController | null = null;
let factor = readFactor();
let stretchTouched = false;
let boxAutoFilled = false;
let measuring = false;
let loadGeneration = 0;
let measuredUrl: string | null = null;
let frameTimes: number[] | null = null;
/** Apple slo-mo tag / detection hint for stretch when gaps look flat on Photos exports. */
let sloMoHint: { slowMoPlayback?: boolean | null } = {};
/** Timestamps parsed from the file. Playback sampling is only the fallback. */
let clockRead: Promise<number[] | null> = Promise.resolve(null);

const BUILD_ID = "2026-10-14c";

cadenceButton.addEventListener("click", () => {
  void detectCadence();
});

slowInput.addEventListener("input", () => {
  const next = Number(slowInput.value);
  if (!Number.isFinite(next) || next < 1) return;
  applyFactor(next);
});

for (const chip of document.querySelectorAll<HTMLButtonElement>("#slowmo-chips button[data-factor]")) {
  chip.addEventListener("click", () => {
    slowInput.value = chip.dataset.factor ?? "1";
    cadenceStatus.textContent = "";
    applyFactor(Number(slowInput.value));
  });
}

autoButton.addEventListener("click", () => {
  void runDetection();
});
cancelDetect.addEventListener("click", () => detecting?.abort());

must<HTMLButtonElement>("#dismiss-guide").addEventListener("click", showAnalyze);
must<HTMLButtonElement>("#open-guide").addEventListener("click", () => {
  closeMenu();
  showGuide();
});

menuButton.addEventListener("click", () => {
  const open = menuPanel.hidden;
  menuPanel.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Node)) return;
  if (menuButton.contains(event.target) || menuPanel.contains(event.target)) return;
  closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
  if (analyze.hidden || !ready) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    step(event.shiftKey ? 10 : 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    step(event.shiftKey ? -10 : -1);
  }
});

videoInput.addEventListener("change", () => {
  const file = videoInput.files?.[0];
  videoInput.value = "";
  if (!file) return;
  loadFile(file);
});

video.addEventListener("loadedmetadata", onReady);
video.addEventListener("durationchange", onReady);
video.addEventListener("error", () => {
  // Keep the file clock usable. A decode error must not wipe timestamps or
  // leave Auto-detect disabled when the sample table already loaded.
  if (frameTimes && frameTimes.length >= 3) {
    ready = true;
    videoStatus.hidden = false;
    videoStatus.textContent = "Preview failed to decode, but frame times are ready. Try Auto-detect or mark by hand.";
    setTransportEnabled(true);
    render();
    return;
  }
  ready = false;
  setTransportEnabled(false);
  videoStatus.hidden = false;
  videoStatus.textContent = "This file could not be played. Try another slo-mo video.";
});

fpsInput.addEventListener("input", () => {
  const fps = readFps();
  clearFeedback();
  if (fps === null) {
    render();
    return;
  }
  seeker.setFps(fps);
  if (ready) setFrame(frame);
  else render();
  maybePrefillBox();
});

scrubber.addEventListener("input", () => {
  if (!ready) return;
  setFrame(Number(scrubber.value));
});

for (const button of stepButtons) {
  button.addEventListener("click", () => {
    step(Number(button.dataset.step));
  });
}

bindMark("stepOff", "#set-so", "#goto-so", "#clear-so");
bindMark("touchdown", "#set-td", "#goto-td", "#clear-td");
bindMark("takeoff", "#set-to", "#goto-to", "#clear-to");
bindMark("landing", "#set-ld", "#goto-ld", "#clear-ld");

jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  onSave();
});
jumpForm.addEventListener("input", clearFeedback);
boxInput.addEventListener("input", () => {
  boxAutoFilled = false;
  syncChips();
  render();
});

for (const chip of document.querySelectorAll<HTMLButtonElement>("#box-chips button")) {
  chip.addEventListener("click", () => {
    boxInput.value = chip.dataset.height ?? "";
    boxAutoFilled = false;
    render();
    syncChips();
    clearFeedback();
  });
}

must<HTMLButtonElement>("#save-jump").addEventListener("click", onSave);
chartMetric.addEventListener("change", renderHistory);
chartJumpType.addEventListener("change", renderHistory);

renderTrials();
render();

function showGuide(): void {
  guide.hidden = false;
  analyze.hidden = true;
  window.scrollTo(0, 0);
}

function showAnalyze(): void {
  guide.hidden = true;
  analyze.hidden = false;
  window.scrollTo(0, 0);
}

function closeMenu(): void {
  menuPanel.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
}

function loadFile(file: File): void {
  detecting?.abort();
  detecting = null;
  loadGeneration += 1;
  measuring = false;
  stretchTouched = false;
  fpsInput.disabled = false;
  cancelDetect.hidden = true;
  detectStatus.textContent = "";
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  const generation = loadGeneration;
  ready = false;
  frame = 0;
  marks.stepOff = null;
  marks.touchdown = null;
  marks.takeoff = null;
  marks.landing = null;
  measuredUrl = null;
  frameTimes = null;
  sloMoHint = {};
  clockRead = file
    .arrayBuffer()
    .then((buffer) => {
      const clip = parseMovClip(new Uint8Array(buffer));
      if (!clip) return null;
      sloMoHint = { slowMoPlayback: clip.slowMoPlayback };
      return clip.times;
    })
    .catch(() => null);
  seeker.setClock(null);
  cadenceStatus.textContent = "";
  clipName.textContent = file.name;
  emptyVideo.hidden = true;
  player.hidden = false;
  videoStatus.hidden = false;
  videoStatus.textContent = "Reading video…";
  setTransportEnabled(false);
  clearFeedback();
  render();
  video.src = objectUrl;
  video.load();
  primePlayback(video);
  // Apply the clock after the sync load work so an error handler cannot
  // disable controls after timestamps are ready.
  void clockRead.then((times) => {
    if (generation !== loadGeneration || !times) return;
    applyFrameClock(times);
    if (!measuring && !detecting) setTransportEnabled(true);
  });
}

function primePlayback(media: HTMLVideoElement): void {
  media.muted = true;
  try {
    void media
      .play()
      .then(() => {
        if (!measuring) media.pause();
      })
      .catch(() => {
        // iOS may block play until the next tap. Frame seeks still run.
      });
  } catch {
    // Same as a rejected play promise.
  }
}

function onReady(): void {
  // A file clock alone is enough to know the frame count; do not wait on duration.
  if (seeker.frameCount <= 0 && !(video.duration > 0)) return;
  ready = true;
  videoStatus.hidden = true;
  scrubber.max = String(Math.max(0, seeker.frameCount - 1));
  setTransportEnabled(transportEnabledAfterClockRead(seeker.frameCount));
  frame = clampFrame(frame, seeker.frameCount);
  render();
  if (objectUrl && measuredUrl !== objectUrl) {
    measuredUrl = objectUrl;
    void detectCadence();
  } else {
    seeker.request(frame);
  }
}

function applyFrameClock(times: readonly number[]): void {
  frameTimes = [...times];
  seeker.setClock(frameTimes);
  const playback = measuredFps(times);
  const stretch = sloMoStretch(times, sloMoHint);
  seeker.setFps(captureFps(times, sloMoHint) ?? playback ?? 240);
  if (!stretchTouched) {
    factor = stretch > 1 ? stretch : 1;
    slowInput.value = String(factor);
    syncChips();
  }
  const capture = captureFps(times, sloMoHint);
  // Always show capture rate when we know the stretch — never leave the
  // playback average (~43) in the fps field on a slo-mo phone export.
  if (capture) fpsInput.value = capture.toFixed(1);
  else if (playback) fpsInput.value = playback.toFixed(1);
  const variable = isVariableRate(times);
  cadenceStatus.textContent =
    stretch > 1
      ? `Capture ${capture ? capture.toFixed(1) : "—"} fps (build ${BUILD_ID}). Playback holds frames at ${playback ? playback.toFixed(0) : "—"} fps, so every duration is divided by ${stretch}× (real time).`
      : variable
        ? `Variable frame rate, average ${playback ? playback.toFixed(0) : "—"} fps over ${frameTimes.length} frames (build ${BUILD_ID}). Times use each frame's timestamp.`
        : `Measured ${playback ? playback.toFixed(0) : "—"} fps from ${frameTimes.length} frame timestamps (build ${BUILD_ID}). Contact, flight, and the box use those times.`;
  // Enable stepping as soon as we have a clock — do not wait for detectCadence.
  if (seeker.frameCount > 0) {
    ready = true;
    if (Number.isFinite(video.duration) && video.duration > 0) videoStatus.hidden = true;
    scrubber.max = String(seeker.frameCount - 1);
    frame = clampFrame(frame, seeker.frameCount);
    if (!measuring && !detecting) setTransportEnabled(true);
    render();
  }
}

/**
 * Reads the file's composition timestamps. Playback sampling runs only when
 * the file has no sample table. Either way the controls come back: a hung
 * `play()` or a missing clock must not leave auto-detect disabled.
 */
async function detectCadence(): Promise<void> {
  if (!ready || measuring || detecting) return;
  const url = objectUrl;
  const generation = loadGeneration;
  // File sample-table clock is already enough. Do not disable the UI or play
  // the clip again — that was leaving Auto-detect stuck off on load.
  let times = frameTimes ?? (await clockRead);
  if (generation !== loadGeneration || url !== objectUrl) return;
  if (times && times.length >= 3) {
    applyFrameClock(times);
    setTransportEnabled(true);
    setFrame(frame);
    return;
  }
  measuring = true;
  setTransportEnabled(false);
  cadenceStatus.textContent = "Reading each frame's timestamp…";
  try {
    times = await collectFrameTimes(video);
    if (generation !== loadGeneration || url !== objectUrl) return;
    if (!times) {
      frameTimes = null;
      seeker.setClock(null);
      cadenceStatus.textContent =
        "Could not read frame timestamps. Auto-detect still runs; times fall back to the frame-rate field.";
      return;
    }
    applyFrameClock(times);
  } finally {
    if (generation !== loadGeneration) return;
    measuring = false;
    video.pause();
    if (ready && url === objectUrl) {
      setTransportEnabled(transportEnabledAfterClockRead(seeker.frameCount));
      setFrame(frame);
    }
  }
}

/**
 * Marks stay on the same frame. The factor only changes real-seconds conversion,
 * so tapping 2×/4×/8× does not move the picture and cannot be applied twice.
 */
/**
 * Playback holds are not real time. Even if the chip still reads 1×, a
 * 1/60-and-1/30 clock must use the detected 4× — that is the 231 in bug.
 */
function activeStretch(): number {
  if (stretchTouched) return factor;
  return metricStretch(frameTimes ?? undefined, factor, sloMoHint);
}

function applyFactor(next: number): void {
  if (!(next >= 1) || next === factor) return;
  stretchTouched = true;
  factor = next;
  clearFeedback();
  render();
  maybePrefillBox();
}

/** Fills the box field from the video estimate unless the user typed a value. */
function maybePrefillBox(): void {
  const fps = readFps();
  if (fps === null || marks.stepOff === null || marks.touchdown === null) return;
  if (boxInput.value.trim() !== "" && !boxAutoFilled) return;
  const estimate = estimateBoxHeight(marks.stepOff, marks.touchdown, fps, activeStretch(), frameTimes ?? undefined);
  if (!estimate) return;
  boxInput.value = String(Math.round(estimate.heightIn * 2) / 2);
  boxAutoFilled = true;
  syncChips();
  render();
}

async function runDetection(): Promise<void> {
  const fps = readFps();
  const count = seeker.frameCount;
  if (!ready || detecting || fps === null || count <= 0) return;
  const controller = new AbortController();
  detecting = controller;
  setTransportEnabled(false);
  fpsInput.disabled = true;
  cancelDetect.hidden = false;
  clearFeedback();
  try {
    const result = await analyzeClip({
      video,
      seeker,
      frameCount: count,
      signal: controller.signal,
      onProgress: (message) => {
        detectStatus.textContent = message;
      },
    });
    if (controller.signal.aborted) {
      detectStatus.textContent = "Auto-detect cancelled.";
      return;
    }
    if (!result.ok) {
      detectStatus.textContent = `Auto-detect failed: ${result.reason} Mark the frames by hand.`;
      return;
    }
    marks.stepOff = stepOffForFall(
      result.events.stepOff,
      result.events.touchdown,
      frameTimes ?? undefined,
      activeStretch(),
    );
    marks.touchdown = result.events.touchdown;
    marks.takeoff = result.events.takeoff;
    marks.landing = result.events.landing;
    frame = result.events.touchdown;
    maybePrefillBox();
    detectStatus.textContent =
      "Auto marks set. Check each one with Go to, step to the right frame, and press Set to correct it.";
  } catch (error) {
    if (controller.signal.aborted) detectStatus.textContent = "Auto-detect cancelled.";
    else detectStatus.textContent = `Auto-detect failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (detecting === controller) {
      detecting = null;
      fpsInput.disabled = false;
      cancelDetect.hidden = true;
      if (ready) {
        setTransportEnabled(true);
        setFrame(frame);
      }
    }
  }
}

function step(delta: number): void {
  if (!ready || detecting || measuring) return;
  setFrame(frame + delta);
}

function setFrame(next: number): void {
  if (detecting) return;
  const count = seeker.frameCount;
  frame = count > 0 ? clampFrame(next, count) : Math.max(0, Math.round(next));
  clearFeedback();
  render();
  seeker.request(frame);
}

function bindMark(
  key: keyof typeof marks,
  setSelector: string,
  gotoSelector: string,
  clearSelector: string,
): void {
  must<HTMLButtonElement>(setSelector).addEventListener("click", () => {
    if (!ready) return;
    marks[key] = frame;
    clearFeedback();
    render();
    maybePrefillBox();
  });
  must<HTMLButtonElement>(gotoSelector).addEventListener("click", () => {
    const marked = marks[key];
    if (marked === null) return;
    setFrame(marked);
  });
  must<HTMLButtonElement>(clearSelector).addEventListener("click", () => {
    marks[key] = null;
    clearFeedback();
    render();
  });
}

function render(): void {
  const fps = readFps();
  const count = fps === null ? 0 : seeker.frameCount;
  frameLabel.textContent = String(frame);
  totalLabel.textContent = String(count);
  const playbackFps = frameTimes ? measuredFps(frameTimes) : null;
  const shownFps = frameTimes ? captureFps(frameTimes, sloMoHint) : null;
  const variable = frameTimes ? isVariableRate(frameTimes) : false;
  const stretch = activeStretch();
  timeLabel.textContent =
    frameTimes && frame < frameTimes.length
      ? formatClock(realSecondsOnClock(frameTimes, 0, frame, playbackFps ?? 1, stretch))
      : "—";
  timingReadout.textContent = frameTimes
    ? sloMoStretch(frameTimes, sloMoHint) > 1
      ? `Capture ${shownFps ? shownFps.toFixed(0) : "—"} fps · ${formatFactor(stretch)}× slow-mo`
      : variable
        ? `Variable · average ${playbackFps ? playbackFps.toFixed(0) : "—"} fps · timed from frame stamps`
        : `Measured ${playbackFps ? playbackFps.toFixed(0) : "—"} fps · ${formatFactor(factor)}× stretch`
    : "Measuring frame times…";
  if (document.activeElement !== scrubber) {
    scrubber.max = String(Math.max(0, count - 1));
    scrubber.value = String(count > 0 ? clampFrame(frame, count) : 0);
  }

  renderMark(marks.stepOff, "#so-frame", "#goto-so", "#clear-so");
  renderMark(marks.touchdown, "#td-frame", "#goto-td", "#clear-td");
  renderMark(marks.takeoff, "#to-frame", "#goto-to", "#clear-to");
  renderMark(marks.landing, "#ld-frame", "#goto-ld", "#clear-ld");
  placePip("#mark-td", marks.touchdown, count);
  placePip("#mark-to", marks.takeoff, count);
  placePip("#mark-ld", marks.landing, count);
  const playhead = must<HTMLElement>("#playhead");
  playhead.style.left = count <= 1 ? "0%" : `${(frame / (count - 1)) * 100}%`;

  const preview = previewMetrics({
    touchdown: marks.touchdown,
    takeoff: marks.takeoff,
    landing: marks.landing,
    fps: fps ?? 0,
    slowMoFactor: stretch,
    frameTimes: frameTimes ?? undefined,
  });
  const anyNumber =
    preview.gctMs !== null || preview.flightMs !== null || preview.heightIn !== null || preview.rsi !== null;
  metricsHint.hidden = preview.message === null;
  if (preview.message) metricsHint.textContent = preview.message;
  metricsValues.hidden = !anyNumber;
  must<HTMLElement>("#m-gct").textContent = preview.gctMs === null ? "—" : formatMsValue(preview.gctMs);
  must<HTMLElement>("#m-ft").textContent = preview.flightMs === null ? "—" : formatMsValue(preview.flightMs);
  must<HTMLElement>("#m-height").textContent = preview.heightIn === null ? "—" : formatInValue(preview.heightIn);
  must<HTMLElement>("#m-height-cm").textContent =
    preview.heightCm === null ? "—" : formatHeightCm(preview.heightCm);
  must<HTMLElement>("#m-rsi").textContent = preview.rsi === null ? "—" : formatRsi(preview.rsi);

  const estimate =
    fps === null || marks.stepOff === null || marks.touchdown === null
      ? null
      : estimateBoxHeight(marks.stepOff, marks.touchdown, fps, stretch, frameTimes ?? undefined);
  const warnings = sanityWarnings({
    heightIn: preview.heightIn,
    gctMs: preview.gctMs,
    boxHeightIn: estimate?.heightIn ?? null,
    fallSeconds: estimate?.fallSeconds ?? null,
  });
  metricsWarning.hidden = warnings.length === 0;
  metricsWarning.textContent =
    warnings.length === 0 ? "" : `${warnings.join(" ")} Check the marks. Timing uses each frame's timestamp.`;

  boxEstimate.hidden = estimate === null;
  boxEstimate.textContent =
    estimate === null
      ? ""
      : `Estimate from video (free fall ${formatMsValue(estimate.fallSeconds * 1000)} ms): ${formatHeightIn(estimate.heightIn)} · ${formatHeightCm(estimate.heightCm)}.${boxAutoFilled ? " Box height filled from this estimate. Edit it if you know the real height." : ""}`;
  syncChips();
}

function renderMark(
  value: number | null,
  labelSelector: string,
  gotoSelector: string,
  clearSelector: string,
): void {
  must<HTMLElement>(labelSelector).textContent = value === null ? "Not set" : `Frame ${value}`;
  must<HTMLButtonElement>(gotoSelector).disabled = value === null;
  must<HTMLButtonElement>(clearSelector).disabled = value === null;
}

function placePip(selector: string, value: number | null, count: number): void {
  const pip = must<HTMLElement>(selector);
  if (value === null || count <= 1 || value < 0 || value > count - 1) {
    pip.hidden = true;
    return;
  }
  pip.hidden = false;
  pip.style.left = `${(value / (count - 1)) * 100}%`;
}

function onSave(): void {
  const fps = readFps();
  const jumpType = selectedValue("jumpType");
  const arm = selectedValue("armSwing");
  const boxHeightIn = readBox();
  const message = trialFormError({
    fps,
    jumpType,
    boxHeightIn,
    armSwing: arm === null ? null : arm === "yes",
    touchdown: marks.touchdown,
    takeoff: marks.takeoff,
    landing: marks.landing,
  });
  if (message || fps === null || boxHeightIn === null || (jumpType !== "drop" && jumpType !== "depth") || arm === null) {
    formError.hidden = false;
    formError.textContent = message ?? "Check the jump and try again.";
    saveStatus.textContent = "";
    return;
  }
  if (marks.touchdown === null || marks.takeoff === null || marks.landing === null) return;

  const trial = createTrial({
    fps,
    jumpType: jumpType as JumpType,
    boxHeightIn,
    armSwing: arm === "yes",
    notes: notesInput.value,
    touchdownFrame: marks.touchdown,
    takeoffFrame: marks.takeoff,
    landingFrame: marks.landing,
    slowMoFactor: activeStretch(),
    stepOffFrame: marks.stepOff,
    frameTimes: frameTimes ?? undefined,
  });
  if (!trial) {
    formError.hidden = false;
    formError.textContent = "Touchdown, takeoff, and landing have to be in that order.";
    return;
  }

  const trials = loadTrials(localStorage);
  const saved = saveTrials([trial, ...trials], localStorage);
  if (!saved) {
    formError.hidden = false;
    formError.textContent = "Could not save on this phone. Storage may be blocked.";
    return;
  }

  marks.stepOff = null;
  marks.touchdown = null;
  marks.takeoff = null;
  marks.landing = null;
  notesInput.value = "";
  formError.hidden = true;
  saveStatus.textContent = "Jump saved on this phone.";
  render();
  renderTrials();
}

function renderTrials(): void {
  const trials = loadTrials(localStorage);
  if (pendingDeleteId && !trials.some((trial) => trial.id === pendingDeleteId)) {
    pendingDeleteId = null;
  }
  savedCount.textContent = String(trials.length);
  savedEmpty.hidden = trials.length > 0;
  jumpList.replaceChildren();
  for (const trial of trials) jumpList.append(renderTrial(trial));
  renderSession(trials);
  renderHistory();
}

function renderSession(trials: TrialRecord[]): void {
  const groups = sessionsForDay(trials);
  sessionEmpty.hidden = groups.length > 0;
  sessionList.replaceChildren();
  for (const group of groups) {
    const item = document.createElement("li");
    item.className = "session-group";
    const title = document.createElement("p");
    title.className = "session-title";
    const target = 3;
    title.textContent = `${formatJumpType(group.jumpType)} · ${formatBoxInches(group.boxHeightIn)} · ${group.count}/${target}`;
    const mean = document.createElement("p");
    mean.className = "detail";
    mean.textContent = `Mean · height ${formatHeightIn(group.mean.heightIn)} · contact ${formatMilliseconds(group.mean.gctMs)} · flight ${formatMilliseconds(group.mean.flightMs)} · RSI ${formatRsi(group.mean.rsi)}`;
    const best = document.createElement("p");
    best.className = "detail";
    best.textContent = `Best · height ${formatHeightIn(group.best.heightIn)} · contact ${formatMilliseconds(group.best.gctMs)} · flight ${formatMilliseconds(group.best.flightMs)} · RSI ${formatRsi(group.best.rsi)}`;
    item.append(title, mean, best);
    sessionList.append(item);
  }
}

function renderHistory(): void {
  const trials = loadTrials(localStorage);
  const metric = chartMetric.value as SessionMetric;
  const typeValue = chartJumpType.value;
  const jumpType = typeValue === "all" ? undefined : (typeValue as JumpType);
  const series = boxProfileByWeek(trials, metric, jumpType);
  chartRoot.replaceChildren(renderBoxChart(series, metric));
  chartLegend.textContent =
    series.length === 0
      ? ""
      : `${metricLabel(metric)} · weeks: ${series.map((entry) => `${entry.label}${jumpType ? "" : ` ${entry.jumpType}`}`).join(", ")}`;
}

function renderTrial(trial: TrialRecord): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "jump";

  const when = document.createElement("p");
  when.className = "when";
  when.textContent = formatWhen(trial.createdAt);

  const title = document.createElement("p");
  title.textContent = `${formatJumpType(trial.jumpType)} · ${formatBoxInches(trial.boxHeightIn)} · ${formatArmSwing(trial.armSwing)}`;

  const detail = document.createElement("p");
  detail.className = "detail";
  detail.textContent = `Jump height ${formatHeightIn(trial.heightIn)} · Contact time ${formatMilliseconds(trial.gctMs)} · Flight time ${formatMilliseconds(trial.flightMs)} · RSI ${formatRsi(trial.rsi)}${trial.slowMoFactor && trial.slowMoFactor !== 1 ? ` · ${trial.slowMoFactor}× slow-mo` : ""}`;

  item.append(when, title, detail);
  if (trial.notes) {
    const notes = document.createElement("p");
    notes.className = "notes";
    notes.textContent = trial.notes;
    item.append(notes);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete";
  const armed = pendingDeleteId === trial.id;
  button.dataset.armed = String(armed);
  button.textContent = armed ? "Confirm delete" : "Delete";
  button.addEventListener("click", () => {
    if (pendingDeleteId !== trial.id) {
      pendingDeleteId = trial.id;
      renderTrials();
      return;
    }
    pendingDeleteId = null;
    const next = loadTrials(localStorage).filter((entry) => entry.id !== trial.id);
    saveTrials(next, localStorage);
    renderTrials();
  });
  item.append(button);
  return item;
}

function syncChips(): void {
  const current = boxInput.value.trim();
  for (const chip of document.querySelectorAll<HTMLButtonElement>("#box-chips button")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.height === current));
  }
  for (const chip of document.querySelectorAll<HTMLButtonElement>("#slowmo-chips button[data-factor]")) {
    chip.setAttribute("aria-pressed", String(Number(chip.dataset.factor) === factor));
  }
}

function formatFactor(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function clearFeedback(): void {
  formError.hidden = true;
  formError.textContent = "";
  saveStatus.textContent = "";
}

function setTransportEnabled(enabled: boolean): void {
  for (const button of stepButtons) button.disabled = !enabled;
  scrubber.disabled = !enabled;
  autoButton.disabled = !enabled;
  cadenceButton.disabled = !enabled;
  for (const id of ["#set-so", "#set-td", "#set-to", "#set-ld"]) {
    must<HTMLButtonElement>(id).disabled = !enabled;
  }
}

function readFps(): number | null {
  const value = Number(fpsInput.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function readFactor(): number {
  const value = Number(must<HTMLInputElement>("#slowmo").value);
  return Number.isFinite(value) && value >= 1 ? value : 1;
}

function readBox(): number | null {
  if (boxInput.value.trim() === "") return null;
  const value = Number(boxInput.value);
  if (!Number.isFinite(value)) return null;
  return value;
}

function selectedValue(name: string): string | null {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return checked?.value ?? null;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
