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
  formatJumpType,
  formatMilliseconds,
  formatRsi,
} from "./format.ts";
import { trialFormError } from "./form.ts";
import { previewMetrics } from "./metrics.ts";
import { FrameSeeker, clampFrame } from "./seek.ts";
import {
  createTrial,
  loadTrials,
  saveTrials,
  type JumpType,
  type TrialRecord,
} from "./storage.ts";

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
const trialForm = must<HTMLFormElement>("#trial-form");
const boxInput = must<HTMLInputElement>("#box-height");
const notesInput = must<HTMLTextAreaElement>("#notes");
const metricsHint = must<HTMLElement>("#metrics-hint");
const metricsValues = must<HTMLElement>("#metrics-values");
const formError = must<HTMLElement>("#form-error");
const saveStatus = must<HTMLElement>("#save-status");
const savedCount = must<HTMLElement>("#saved-count");
const savedEmpty = must<HTMLElement>("#saved-empty");
const trialList = must<HTMLUListElement>("#trial-list");

video.playsInline = true;
video.setAttribute("playsinline", "");
video.setAttribute("webkit-playsinline", "");
video.muted = true;
video.controls = false;

const seeker = new FrameSeeker(video, readFps() ?? 240);

const marks = {
  touchdown: null as number | null,
  takeoff: null as number | null,
  landing: null as number | null,
};

let frame = 0;
let ready = false;
let objectUrl: string | null = null;
let pendingDeleteId: string | null = null;

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

bindMark("touchdown", "#set-td", "#goto-td", "#clear-td");
bindMark("takeoff", "#set-to", "#goto-to", "#clear-to");
bindMark("landing", "#set-ld", "#goto-ld", "#clear-ld");

trialForm.addEventListener("submit", (event) => {
  event.preventDefault();
  onSave();
});
trialForm.addEventListener("input", clearFeedback);
boxInput.addEventListener("input", syncChips);

for (const chip of document.querySelectorAll<HTMLButtonElement>("#box-chips button")) {
  chip.addEventListener("click", () => {
    boxInput.value = chip.dataset.height ?? "";
    syncChips();
    clearFeedback();
  });
}

must<HTMLButtonElement>("#save-trial").addEventListener("click", onSave);

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
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  ready = false;
  frame = 0;
  marks.touchdown = null;
  marks.takeoff = null;
  marks.landing = null;
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
}

function primePlayback(media: HTMLVideoElement): void {
  media.muted = true;
  try {
    void media
      .play()
      .then(() => {
        media.pause();
      })
      .catch(() => {
        // iOS may block play until the next tap. Frame seeks still run.
      });
  } catch {
    // Same as a rejected play promise.
  }
}

function onReady(): void {
  const count = seeker.frameCount;
  if (count <= 0) return;
  ready = true;
  videoStatus.hidden = true;
  scrubber.max = String(count - 1);
  setTransportEnabled(true);
  frame = clampFrame(frame, count);
  render();
  seeker.request(frame);
}

function step(delta: number): void {
  if (!ready) return;
  setFrame(frame + delta);
}

function setFrame(next: number): void {
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
  timeLabel.textContent = fps === null ? "—" : formatClock(frame / fps);
  if (document.activeElement !== scrubber) {
    scrubber.max = String(Math.max(0, count - 1));
    scrubber.value = String(count > 0 ? clampFrame(frame, count) : 0);
  }

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
  });
  const anyNumber =
    preview.gctMs !== null || preview.flightMs !== null || preview.heightIn !== null || preview.rsi !== null;
  metricsHint.hidden = preview.message === null;
  if (preview.message) metricsHint.textContent = preview.message;
  metricsValues.hidden = !anyNumber;
  must<HTMLElement>("#m-gct").textContent = preview.gctMs === null ? "—" : formatMilliseconds(preview.gctMs);
  must<HTMLElement>("#m-ft").textContent = preview.flightMs === null ? "—" : formatMilliseconds(preview.flightMs);
  must<HTMLElement>("#m-height").textContent = preview.heightIn === null ? "—" : formatHeightIn(preview.heightIn);
  must<HTMLElement>("#m-height-cm").textContent =
    preview.heightCm === null ? "—" : formatHeightCm(preview.heightCm);
  must<HTMLElement>("#m-rsi").textContent = preview.rsi === null ? "—" : formatRsi(preview.rsi);
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
    formError.textContent = message ?? "Check the trial and try again.";
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

  marks.touchdown = null;
  marks.takeoff = null;
  marks.landing = null;
  notesInput.value = "";
  formError.hidden = true;
  saveStatus.textContent = "Trial saved on this phone.";
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
  trialList.replaceChildren();
  for (const trial of trials) trialList.append(renderTrial(trial));
}

function renderTrial(trial: TrialRecord): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "trial";

  const when = document.createElement("p");
  when.className = "when";
  when.textContent = formatWhen(trial.createdAt);

  const title = document.createElement("p");
  title.textContent = `${formatJumpType(trial.jumpType)} · ${formatBoxInches(trial.boxHeightIn)} · ${formatArmSwing(trial.armSwing)}`;

  const detail = document.createElement("p");
  detail.className = "detail";
  detail.textContent = `${formatMilliseconds(trial.gctMs)} GCT · ${formatMilliseconds(trial.flightMs)} flight · ${formatHeightIn(trial.heightIn)} · ${formatRsi(trial.rsi)}`;

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
}

function clearFeedback(): void {
  formError.hidden = true;
  formError.textContent = "";
  saveStatus.textContent = "";
}

function setTransportEnabled(enabled: boolean): void {
  for (const button of stepButtons) button.disabled = !enabled;
  scrubber.disabled = !enabled;
  for (const id of ["#set-td", "#set-to", "#set-ld"]) {
    must<HTMLButtonElement>(id).disabled = !enabled;
  }
}

function readFps(): number | null {
  const value = Number(fpsInput.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
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
