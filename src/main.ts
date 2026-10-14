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
import { analyzeMultiClip } from "./pose.ts";
import {
  buildMultiJumpRows,
  createSetId,
  summarizeSet,
  type MultiJumpRow,
} from "./multiJump.ts";
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
import { metricByDate, sessionsForDay, trialDay, weekKey, type SessionMetric } from "./sessions.ts";
import { metricLabel, renderBoxChart } from "./chart.ts";
import { BUILD_ID, ensureLatestBuild } from "./version.ts";
import {
  DEFAULT_CV,
  evaluateCell,
  formatFlag,
  formatStatus,
  loadRebaselineWeeks,
  setRebaselineWeek,
  type FlagMetric,
  type MetricBaseline,
} from "./baseline.ts";
import {
  loadGctTargetMs,
  needsProfileRetest,
  raiseBoxSignal,
  saveGctTargetMs,
} from "./raiseBox.ts";
import {
  BOX_TEST_HEIGHT_CHOICES,
  DEFAULT_BOX_TEST_HEIGHTS,
  createBoxTestId,
  recommendBoxHeight,
  renderBoxTestChart,
  saveWorkingBox,
} from "./boxTest.ts";
import {
  processBoxTestClip,
  recomputeRowMetrics,
  summariesFromRowResults,
  type BoxTestRowResult,
} from "./boxTestPipeline.ts";
import {
  buildCsvText,
  buildWorkbookBlob,
  downloadBlob,
  sortMasterRows,
  trialToViewRow,
  type MasterSortKey,
} from "./masterLog.ts";
import {
  loadGithubToken,
  loadSyncMeta,
  markDirty,
  saveGithubToken,
  syncGithubLog,
} from "./githubSync.ts";

const guide = must<HTMLElement>("#guide");
const analyze = must<HTMLElement>("#analyze");
const screenBox = must<HTMLElement>("#screen-box");
const screenMaster = must<HTMLElement>("#screen-master");
const menuButton = must<HTMLButtonElement>("#menu-button");
const menuPanel = must<HTMLElement>("#menu-panel");
const VISITED_KEY = "jumpLab.visited.v1";
type AppScreen = "directions" | "box" | "analyze" | "master";
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
const multiJumpPanel = must<HTMLElement>("#multi-jump-panel");
const multiJumpList = must<HTMLElement>("#multi-jump-list");
const multiJumpSummary = must<HTMLElement>("#multi-jump-summary");
const multiJumpStatus = must<HTMLElement>("#multi-jump-status");
const multiJumpSave = must<HTMLButtonElement>("#multi-jump-save");
let multiJumpRows: MultiJumpRow[] = [];
const jumpList = must<HTMLUListElement>("#jump-list");
const sessionEmpty = must<HTMLElement>("#session-empty");
const sessionList = must<HTMLUListElement>("#session-list");
const gctTargetInput = must<HTMLInputElement>("#gct-target");
const profileRetest = must<HTMLElement>("#profile-retest");
const boxTestType = must<HTMLSelectElement>("#box-test-type");
const boxTestStatus = must<HTMLElement>("#box-test-status");
const boxTestRows = must<HTMLUListElement>("#box-test-rows");
const boxTestAddHeight = must<HTMLSelectElement>("#box-test-add-height");
const boxTestAdd = must<HTMLButtonElement>("#box-test-add");
const boxTestSubmit = must<HTMLButtonElement>("#box-test-submit");
const boxTestResult = must<HTMLElement>("#box-test-result");
const boxTestChart = must<HTMLElement>("#box-test-chart");
const boxTestFile = must<HTMLInputElement>("#box-test-file");
const masterBody = must<HTMLTableSectionElement>("#master-body");
const masterEmpty = must<HTMLElement>("#master-empty");
const masterExportStatus = must<HTMLElement>("#master-export-status");
const githubTokenInput = must<HTMLInputElement>("#github-token");
const githubSyncStatus = must<HTMLElement>("#github-sync-status");
let masterSortKey: MasterSortKey = "date";
let masterSortAsc = false;
let githubSyncBusy = false;
let githubSyncAgain = false;
/** Ordered heights on the box-test screen (3–5). */
let boxTestHeights: number[] = [...DEFAULT_BOX_TEST_HEIGHTS];
/** Results keyed by box height. */
const boxTestResults = new Map<number, BoxTestRowResult>();
let boxTestUploadTarget: number | null = null;
let boxTestBusy: AbortController | null = null;
let boxTestSessionId = createBoxTestId();
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

const buildLabel = document.querySelector("#build-label");
if (buildLabel) buildLabel.textContent = BUILD_ID;
void ensureLatestBuild();
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}

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

must<HTMLButtonElement>("#dismiss-guide").addEventListener("click", () => showScreen("analyze"));
must<HTMLButtonElement>("#nav-directions").addEventListener("click", () => {
  closeMenu();
  showScreen("directions");
});
must<HTMLButtonElement>("#nav-box-test").addEventListener("click", () => {
  closeMenu();
  showScreen("box");
});
must<HTMLButtonElement>("#nav-analyze").addEventListener("click", () => {
  closeMenu();
  showScreen("analyze");
});
must<HTMLButtonElement>("#nav-master-log").addEventListener("click", () => {
  closeMenu();
  showScreen("master");
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
gctTargetInput.value = String(loadGctTargetMs(localStorage));
gctTargetInput.addEventListener("change", () => {
  const value = Number(gctTargetInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    gctTargetInput.value = String(loadGctTargetMs(localStorage));
    return;
  }
  saveGctTargetMs(localStorage, value);
  renderTrials();
});
boxTestAdd.addEventListener("click", () => {
  const height = Number(boxTestAddHeight.value);
  if (!BOX_TEST_HEIGHT_CHOICES.includes(height as (typeof BOX_TEST_HEIGHT_CHOICES)[number])) return;
  if (boxTestHeights.includes(height)) {
    boxTestStatus.textContent = `${height} in is already on the list.`;
    return;
  }
  if (boxTestHeights.length >= 5) {
    boxTestStatus.textContent = "At most 5 heights.";
    return;
  }
  boxTestHeights = [...boxTestHeights, height].sort((a, b) => a - b);
  renderBoxTestRows();
});
boxTestFile.addEventListener("change", () => {
  const file = boxTestFile.files?.[0];
  const height = boxTestUploadTarget;
  boxTestFile.value = "";
  boxTestUploadTarget = null;
  if (!file || height === null) return;
  void runBoxTestUpload(height, file);
});
boxTestSubmit.addEventListener("click", () => submitBoxTest());

renderBoxTestRows();
initMasterLogUi();
const firstVisit = localStorage.getItem(VISITED_KEY) !== "1";
showScreen(firstVisit ? "directions" : "analyze");
renderTrials();
render();

function initMasterLogUi(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#master-table [data-sort]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.sort as MasterSortKey;
      if (masterSortKey === key) masterSortAsc = !masterSortAsc;
      else {
        masterSortKey = key;
        masterSortAsc = key === "date" ? false : true;
      }
      renderMasterLog();
    });
  }
  must<HTMLButtonElement>("#master-export-xlsx").addEventListener("click", () => {
    void (async () => {
      try {
        const trials = loadTrials(localStorage);
        await downloadBlob(buildWorkbookBlob(trials), `jump-lab-${stamp()}.xlsx`);
        masterExportStatus.textContent = "Excel file ready — use Share / Save to Files on iPhone.";
      } catch (error) {
        masterExportStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    })();
  });
  must<HTMLButtonElement>("#master-export-csv").addEventListener("click", () => {
    void (async () => {
      try {
        const trials = loadTrials(localStorage);
        const blob = new Blob([buildCsvText(trials)], { type: "text/csv;charset=utf-8" });
        await downloadBlob(blob, `jump-lab-${stamp()}.csv`);
        masterExportStatus.textContent = "CSV ready — use Share / Save to Files on iPhone.";
      } catch (error) {
        masterExportStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    })();
  });
  githubTokenInput.value = loadGithubToken(localStorage);
  must<HTMLButtonElement>("#github-token-save").addEventListener("click", () => {
    if (!saveGithubToken(localStorage, githubTokenInput.value)) {
      githubSyncStatus.textContent = "Could not save token.";
      return;
    }
    githubTokenInput.value = loadGithubToken(localStorage);
    githubSyncStatus.textContent = githubTokenInput.value
      ? "Token saved in this browser only. Syncing…"
      : "Token cleared.";
    renderGithubSyncStatus();
    if (githubTokenInput.value) void runGithubSync({ force: true });
  });
  must<HTMLButtonElement>("#github-sync-now").addEventListener("click", () => {
    void runGithubSync({ force: true });
  });
  renderGithubSyncStatus();
  if (loadGithubToken(localStorage)) void runGithubSync({ force: true });
}

function renderGithubSyncStatus(): void {
  const meta = loadSyncMeta(localStorage);
  const hasToken = Boolean(loadGithubToken(localStorage));
  const parts: string[] = [];
  if (!hasToken) parts.push("No token — add one so the jump log syncs to GitHub.");
  else if (meta.dirty) parts.push("Pending sync");
  else if (meta.lastSyncedAt) {
    const when = new Date(meta.lastSyncedAt);
    parts.push(
      Number.isNaN(when.getTime())
        ? `Last synced ${meta.lastSyncedAt}`
        : `Last synced ${when.toLocaleString()}`,
    );
  } else parts.push("Never synced.");
  if (meta.lastError) parts.push(`Last error: ${meta.lastError}`);
  githubSyncStatus.textContent = parts.join(" · ");
}

/**
 * Persist trials to the local cache/outbox and push to GitHub immediately.
 * Returns whether the GitHub write succeeded (no token → false / queued).
 */
async function persistJumpLog(next: TrialRecord[]): Promise<boolean> {
  if (!saveTrials(next, localStorage)) return false;
  markDirty(localStorage);
  renderGithubSyncStatus();
  if (!loadGithubToken(localStorage)) return false;
  return runGithubSync({ force: true });
}

async function runGithubSync(options: { force: boolean }): Promise<boolean> {
  if (githubSyncBusy) {
    githubSyncAgain = true;
    return false;
  }
  const token = loadGithubToken(localStorage);
  if (!token) {
    if (options.force) githubSyncStatus.textContent = "Add a GitHub token first.";
    return false;
  }
  const meta = loadSyncMeta(localStorage);
  if (!options.force && !meta.dirty) return true;

  githubSyncBusy = true;
  githubSyncStatus.textContent = "Syncing to GitHub…";
  let ok = false;
  try {
    do {
      githubSyncAgain = false;
      const result = await syncGithubLog({
        token,
        getLocalTrials: () => loadTrials(localStorage),
        storage: localStorage,
      });
      if (result.error) {
        markDirty(localStorage);
        renderGithubSyncStatus();
        ok = false;
        break;
      }
      saveTrials(result.merged, localStorage);
      renderTrials();
      if (result.needsRepush || loadSyncMeta(localStorage).dirty || githubSyncAgain) {
        markDirty(localStorage);
        githubSyncAgain = true;
        continue;
      }
      const pulledNote = result.pulled > 0 ? ` Restored ${result.pulled} from repo.` : "";
      renderGithubSyncStatus();
      githubSyncStatus.textContent = `Synced ${result.merged.length} jumps.${pulledNote}`;
      ok = result.pushed;
    } while (githubSyncAgain);
  } finally {
    githubSyncBusy = false;
  }
  if (githubSyncAgain) return runGithubSync({ force: true });
  return ok;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderMasterLog(): void {
  const trials = loadTrials(localStorage);
  const rows = sortMasterRows(trials.map(trialToViewRow), masterSortKey, masterSortAsc);
  masterEmpty.hidden = rows.length > 0;
  masterBody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.date,
      row.week === "" ? "—" : String(row.week),
      row.jumpType,
      String(row.box),
      row.armSwing ? "Yes" : "No",
      row.heightIn.toFixed(2),
      row.gctMs.toFixed(1),
      row.flightMs.toFixed(1),
      row.rsi.toFixed(2),
      row.testId || "—",
      row.notes || "—",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement("td");
    actions.className = "master-actions-cell";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "text-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editMasterTrial(row.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "text-button";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      if (!confirm("Delete this jump from the log?")) return;
      const next = loadTrials(localStorage).filter((trial) => trial.id !== row.id);
      void persistJumpLog(next).then(() => renderTrials());
    });
    actions.append(edit, del);
    tr.append(actions);
    masterBody.append(tr);
  }
}

function editMasterTrial(id: string): void {
  const trials = loadTrials(localStorage);
  const trial = trials.find((entry) => entry.id === id);
  if (!trial) return;
  const jumpTypeRaw = prompt("Jump type (drop or depth)", trial.jumpType);
  if (jumpTypeRaw !== "drop" && jumpTypeRaw !== "depth") return;
  const jumpType: JumpType = jumpTypeRaw;
  const boxText = prompt("Box height (in)", String(trial.boxHeightIn));
  const boxHeightIn = Number(boxText);
  if (!(boxHeightIn > 0)) return;
  const armText = prompt("Arm swing (yes/no)", trial.armSwing ? "yes" : "no");
  if (armText !== "yes" && armText !== "no") return;
  const notes = prompt("Notes", trial.notes);
  if (notes === null) return;
  const next = trials.map((entry) =>
    entry.id === id
      ? { ...entry, jumpType, boxHeightIn, armSwing: armText === "yes", notes: notes.trim() }
      : entry,
  );
  void persistJumpLog(next).then(() => renderTrials());
}

function renderBoxTestRows(): void {
  boxTestRows.replaceChildren();
  const done = [...boxTestResults.keys()].filter((h) => boxTestHeights.includes(h)).length;
  boxTestStatus.textContent = `${done}/${boxTestHeights.length} heights have a clip · need 3+ to submit`;
  boxTestSubmit.disabled = done < 3 || boxTestBusy !== null;

  for (const height of boxTestHeights) {
    const result = boxTestResults.get(height) ?? null;
    const item = document.createElement("li");
    item.className = "box-test-row";

    const head = document.createElement("div");
    head.className = "box-test-row-head";
    const title = document.createElement("p");
    title.className = "box-test-row-title";
    title.textContent = `${height} in`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.disabled = boxTestHeights.length <= 3;
    remove.addEventListener("click", () => {
      if (boxTestHeights.length <= 3) return;
      boxTestHeights = boxTestHeights.filter((h) => h !== height);
      boxTestResults.delete(height);
      renderBoxTestRows();
    });
    head.append(title, remove);

    const status = document.createElement("p");
    status.className = "detail";
    status.dataset.role = "status";
    status.textContent = result ? result.fileName : "No clip yet";

    const metrics = document.createElement("div");
    metrics.className = "box-test-row-metrics";
    if (result) {
      metrics.innerHTML = "";
      for (const [label, value] of [
        ["Contact", `${result.gctMs.toFixed(0)} ms`],
        ["Height", `${result.heightIn.toFixed(2)} in`],
        ["RSI", result.rsi.toFixed(2)],
      ] as const) {
        const cell = document.createElement("div");
        const dt = document.createElement("span");
        dt.className = "jump-metric-label";
        dt.textContent = label;
        const dd = document.createElement("span");
        dd.className = "jump-metric-value";
        dd.textContent = value;
        cell.append(dt, dd);
        metrics.append(cell);
      }
    } else {
      metrics.textContent = "Upload a clip to measure this height.";
    }

    const actions = document.createElement("div");
    actions.className = "box-test-row-actions";
    const upload = document.createElement("button");
    upload.type = "button";
    upload.className = "button-secondary";
    upload.textContent = result ? "Replace video" : "Upload video";
    upload.disabled = boxTestBusy !== null;
    upload.addEventListener("click", () => {
      boxTestUploadTarget = height;
      boxTestFile.click();
    });
    actions.append(upload);

    item.append(head, status, metrics, actions);

    if (result) {
      const nudge = document.createElement("details");
      nudge.className = "box-test-nudge";
      const summary = document.createElement("summary");
      summary.textContent = "Nudge marks";
      nudge.append(summary);
      for (const key of ["touchdown", "takeoff", "landing"] as const) {
        const row = document.createElement("div");
        row.className = "box-test-nudge-row";
        const label = document.createElement("span");
        label.textContent = `${key} ${result[key]}`;
        const minus = document.createElement("button");
        minus.type = "button";
        minus.textContent = "−1";
        const plus = document.createElement("button");
        plus.type = "button";
        plus.textContent = "+1";
        const apply = (delta: number) => {
          const next = {
            touchdown: result.touchdown,
            takeoff: result.takeoff,
            landing: result.landing,
          };
          next[key] += delta;
          const updated = recomputeRowMetrics(result, next.touchdown, next.takeoff, next.landing);
          if (!updated) {
            status.textContent = "Marks must stay touchdown < takeoff < landing.";
            return;
          }
          boxTestResults.set(height, updated);
          renderBoxTestRows();
        };
        minus.addEventListener("click", () => apply(-1));
        plus.addEventListener("click", () => apply(1));
        row.append(label, minus, plus);
        nudge.append(row);
      }
      item.append(nudge);
    }

    boxTestRows.append(item);
  }
}

async function runBoxTestUpload(height: number, file: File): Promise<void> {
  boxTestBusy?.abort();
  const controller = new AbortController();
  boxTestBusy = controller;
  renderBoxTestRows();
  const statusNodes = boxTestRows.querySelectorAll("[data-role='status']");
  // Find the row status by re-render message via boxTestStatus for progress.
  boxTestStatus.textContent = `Reading ${height} in…`;
  try {
    const result = await processBoxTestClip(
      file,
      height,
      (message) => {
        boxTestStatus.textContent = `${height} in · ${message}`;
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    boxTestResults.set(height, result);
    boxTestStatus.textContent = `${height} in ready.`;
  } catch (error) {
    if (controller.signal.aborted) boxTestStatus.textContent = "Upload cancelled.";
    else {
      boxTestStatus.textContent = `${height} in failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (boxTestBusy === controller) boxTestBusy = null;
    renderBoxTestRows();
    void statusNodes;
  }
}

function submitBoxTest(): void {
  const rows = boxTestHeights
    .map((h) => boxTestResults.get(h))
    .filter((row): row is BoxTestRowResult => Boolean(row));
  if (rows.length < 3) {
    boxTestStatus.textContent = "Need results for at least 3 heights.";
    return;
  }
  const jumpType = boxTestType.value as JumpType;
  const testId = boxTestSessionId;
  const created: TrialRecord[] = [];
  for (const row of rows) {
    const trial = createTrial({
      fps: row.fps,
      jumpType,
      boxHeightIn: row.boxHeightIn,
      armSwing: false,
      notes: `Box test ${testId}`,
      touchdownFrame: row.touchdown,
      takeoffFrame: row.takeoff,
      landingFrame: row.landing,
      slowMoFactor: row.slowMoFactor,
      stepOffFrame: row.stepOff,
      boxTestId: testId,
      frameTimes: row.frameTimes.length ? row.frameTimes : undefined,
    });
    if (trial) created.push(trial);
  }
  if (created.length < 3) {
    boxTestStatus.textContent = "Could not save enough jumps from this test.";
    return;
  }
  const existing = loadTrials(localStorage);
  void (async () => {
    const synced = await persistJumpLog([...created, ...existing]);
    if (!loadTrials(localStorage).some((t) => created.some((c) => c.id === t.id))) {
      boxTestStatus.textContent = "Could not save the jump log.";
      return;
    }
    const summaries = summariesFromRowResults(rows);
    const rec = recommendBoxHeight(summaries, loadGctTargetMs(localStorage), DEFAULT_CV);
    if (!rec) {
      boxTestResult.hidden = false;
      boxTestResult.textContent = "Not enough data to recommend.";
      return;
    }
    saveWorkingBox(localStorage, jumpType, rec.recommendedBoxIn);
    boxInput.value = String(rec.recommendedBoxIn);
    boxAutoFilled = false;
    syncChips();
    boxTestResult.hidden = false;
    boxTestResult.textContent = rec.message;
    boxTestChart.replaceChildren(renderBoxTestChart(rec.summaries));
    boxTestSessionId = createBoxTestId();
    boxTestStatus.textContent = synced
      ? "Test saved to your jump log. Working box updated."
      : "Test saved, will sync. Working box updated.";
    renderTrials();
  })();
}

function showScreen(screen: AppScreen): void {
  guide.hidden = screen !== "directions";
  screenBox.hidden = screen !== "box";
  analyze.hidden = screen !== "analyze";
  screenMaster.hidden = screen !== "master";
  if (screen === "master") renderMasterLog();
  if (screen !== "directions") {
    try {
      localStorage.setItem(VISITED_KEY, "1");
    } catch {
      // ignore
    }
  }
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
  multiJumpPanel.hidden = true;
  multiJumpRows = [];
  try {
    const result = await analyzeMultiClip({
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
    const stretch = activeStretch();
    const jumps = result.jumps.map((events) => ({
      ...events,
      stepOff: stepOffForFall(events.stepOff, events.touchdown, frameTimes ?? undefined, stretch),
    }));
    if (jumps.length === 1) {
      const events = jumps[0]!;
      marks.stepOff = events.stepOff;
      marks.touchdown = events.touchdown;
      marks.takeoff = events.takeoff;
      marks.landing = events.landing;
      frame = events.touchdown;
      maybePrefillBox();
      detectStatus.textContent =
        "Auto marks set. Check each one with Go to, step to the right frame, and press Set to correct it.";
      return;
    }
    multiJumpRows = buildMultiJumpRows(jumps, frameTimes ?? undefined, fps, stretch);
    renderMultiJumpPanel();
    const first = jumps[0]!;
    marks.stepOff = first.stepOff;
    marks.touchdown = first.touchdown;
    marks.takeoff = first.takeoff;
    marks.landing = first.landing;
    frame = first.touchdown;
    maybePrefillBox();
    detectStatus.textContent = `Found ${jumps.length} jumps. Review the set below, then save included jumps.`;
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

function renderMultiJumpPanel(): void {
  const fps = readFps();
  if (fps === null || multiJumpRows.length === 0) {
    multiJumpPanel.hidden = true;
    return;
  }
  multiJumpPanel.hidden = false;
  const stretch = activeStretch();
  multiJumpRows = buildMultiJumpRows(
    multiJumpRows.map((row) => row.events),
    frameTimes ?? undefined,
    fps,
    stretch,
  ).map((row, i) => ({ ...row, include: multiJumpRows[i]?.include ?? true }));
  const summary = summarizeSet(multiJumpRows);
  multiJumpSummary.textContent =
    summary.count === 0
      ? "No jumps included."
      : `Included ${summary.count}: mean height ${summary.meanHeightIn?.toFixed(1)} in (best ${summary.bestHeightIn?.toFixed(1)}), mean GCT ${summary.meanGctMs?.toFixed(0)} ms, mean RSI ${summary.meanRsi?.toFixed(2)} (best ${summary.bestRsi?.toFixed(2)}).`;
  multiJumpList.replaceChildren();
  for (const row of multiJumpRows) {
    const li = document.createElement("li");
    li.className = "multi-jump-item";
    const head = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = row.include;
    check.addEventListener("change", () => {
      row.include = check.checked;
      renderMultiJumpPanel();
    });
    head.append(
      check,
      document.createTextNode(
        ` Jump ${row.index + 1}: height ${row.heightIn?.toFixed(1) ?? "—"} in · GCT ${row.gctMs?.toFixed(0) ?? "—"} ms · RSI ${row.rsi?.toFixed(2) ?? "—"}`,
      ),
    );
    li.append(head);
    if (row.outsideSlow) {
      const warn = document.createElement("p");
      warn.className = "warn";
      warn.textContent = "Outside slowed (high-capture-rate) section — timing less accurate.";
      li.append(warn);
    }
    const nudge = document.createElement("div");
    nudge.className = "multi-jump-nudge";
    for (const key of ["touchdown", "takeoff", "landing"] as const) {
      const label = key === "touchdown" ? "TD" : key === "takeoff" ? "TO" : "LD";
      for (const delta of [-1, 1]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = `${label}${delta < 0 ? "−" : "+"}`;
        btn.addEventListener("click", () => {
          const next = {
            ...row.events,
            [key]: Math.max(0, row.events[key] + delta),
          };
          if (!(next.touchdown < next.takeoff && next.takeoff < next.landing)) return;
          row.events = next;
          marks.stepOff = next.stepOff;
          marks.touchdown = next.touchdown;
          marks.takeoff = next.takeoff;
          marks.landing = next.landing;
          frame = next[key];
          renderMultiJumpPanel();
          setFrame(frame);
        });
        nudge.append(btn);
      }
    }
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Go to TD";
    go.addEventListener("click", () => {
      marks.stepOff = row.events.stepOff;
      marks.touchdown = row.events.touchdown;
      marks.takeoff = row.events.takeoff;
      marks.landing = row.events.landing;
      setFrame(row.events.touchdown);
    });
    nudge.append(go);
    li.append(nudge);
    multiJumpList.append(li);
  }
}

multiJumpSave.addEventListener("click", () => {
  void saveMultiJumpSet();
});

async function saveMultiJumpSet(): Promise<void> {
  const fps = readFps();
  const jumpType = selectedValue("jumpType");
  const arm = selectedValue("armSwing");
  const boxHeightIn = readBox();
  if (fps === null || boxHeightIn === null || (jumpType !== "drop" && jumpType !== "depth") || arm === null) {
    multiJumpStatus.textContent = "Set jump type, box height, and arm swing first.";
    return;
  }
  const included = multiJumpRows.filter((row) => row.include);
  if (included.length === 0) {
    multiJumpStatus.textContent = "Include at least one jump.";
    return;
  }
  const setId = createSetId();
  const stretch = activeStretch();
  const created: TrialRecord[] = [];
  for (const row of included) {
    const trial = createTrial({
      fps,
      jumpType,
      boxHeightIn,
      armSwing: arm === "yes",
      notes: notesInput.value,
      touchdownFrame: row.events.touchdown,
      takeoffFrame: row.events.takeoff,
      landingFrame: row.events.landing,
      slowMoFactor: stretch,
      stepOffFrame: row.events.stepOff,
      setId,
      frameTimes: frameTimes ?? undefined,
    });
    if (trial) created.push(trial);
  }
  if (created.length === 0) {
    multiJumpStatus.textContent = "Could not build trials from marks.";
    return;
  }
  const existing = loadTrials(localStorage);
  const synced = await persistJumpLog([...created, ...existing]);
  multiJumpStatus.textContent = synced
    ? `Saved ${created.length} jumps to your jump log (${setId}).`
    : `Saved ${created.length} jumps, will sync (${setId}).`;
  renderTrials();
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
    preview.heightCm === null ? "in" : `${formatHeightCm(preview.heightCm)}`;
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
  marks.stepOff = null;
  marks.touchdown = null;
  marks.takeoff = null;
  marks.landing = null;
  notesInput.value = "";
  formError.hidden = true;
  saveStatus.textContent = "Saving…";
  render();
  void (async () => {
    const synced = await persistJumpLog([trial, ...trials]);
    if (!loadTrials(localStorage).some((t) => t.id === trial.id)) {
      formError.hidden = false;
      formError.textContent = "Could not save the jump log. Storage may be blocked.";
      saveStatus.textContent = "";
      return;
    }
    saveStatus.textContent = synced ? "Saved to your jump log" : "Saved, will sync";
    renderTrials();
    must<HTMLElement>("#session-section").scrollIntoView({ block: "start" });
  })();
}

function renderTrials(): void {
  const trials = loadTrials(localStorage);
  if (pendingDeleteId && !trials.some((trial) => trial.id === pendingDeleteId)) {
    pendingDeleteId = null;
  }
  // Session + chart first so a chart paint error cannot hide them behind only the list.
  try {
    renderSession(trials);
  } catch {
    sessionEmpty.hidden = false;
    sessionEmpty.textContent = "Could not load today’s session.";
  }
  try {
    renderHistory();
  } catch {
    chartRoot.replaceChildren();
    chartLegend.textContent = "Could not draw the box chart.";
  }
  savedCount.textContent = String(trials.length);
  savedEmpty.hidden = trials.length > 0;
  jumpList.replaceChildren();
  for (const trial of trials) jumpList.append(renderTrial(trial));
  if (!screenMaster.hidden) renderMasterLog();
}

function renderSession(trials: TrialRecord[]): void {
  const groups = sessionsForDay(trials);
  sessionEmpty.hidden = groups.length > 0;
  sessionEmpty.textContent = "No jumps saved today yet.";
  sessionList.replaceChildren();
  const rebaseline = loadRebaselineWeeks(localStorage);
  const today = trialDay(new Date().toISOString());
  const thisWeek = weekKey(today);
  const gctTarget = loadGctTargetMs(localStorage);
  gctTargetInput.value = String(gctTarget);

  const retest = needsProfileRetest(trials, today);
  profileRetest.hidden = !retest.needed;
  profileRetest.textContent = retest.needed
    ? retest.lastProfileDay
      ? `Box-profile retest due · last full profile ${retest.lastProfileDay} (${retest.weeksSince} weeks ago)`
      : "Box-profile retest due · no day with 3+ box heights yet"
    : "";

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

    const cut = rebaseline[`${group.jumpType}|${group.boxHeightIn}`] ?? null;
    const cell = evaluateCell(trials, group.jumpType, group.boxHeightIn, thisWeek, cut);
    const statusLine = document.createElement("p");
    statusLine.className = "detail baseline-status";
    statusLine.textContent = `Baseline · ${formatStatus(cell.metrics.heightIn.status)} · CV ${(cell.metrics.heightIn.cv * 100).toFixed(1)}%`;
    item.append(statusLine);
    for (const metric of ["heightIn", "gctMs", "rsi"] as FlagMetric[]) {
      item.append(renderBaselineMetric(cell.metrics[metric]));
    }
    const raise = raiseBoxSignal(cell, gctTarget);
    const raiseLine = document.createElement("p");
    raiseLine.className = `detail raise-box raise-${raise.signal}`;
    raiseLine.textContent = raise.reason;
    item.append(raiseLine);
    const rebase = document.createElement("button");
    rebase.type = "button";
    rebase.className = "text-button rebaseline";
    rebase.textContent = "Re-baseline from this week";
    rebase.addEventListener("click", () => {
      setRebaselineWeek(localStorage, group.jumpType, group.boxHeightIn, thisWeek);
      renderTrials();
    });
    item.append(rebase);
    sessionList.append(item);
  }
}

function renderBaselineMetric(metric: MetricBaseline): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = "detail baseline-metric";
  const label =
    metric.metric === "heightIn" ? "Height" : metric.metric === "gctMs" ? "Contact" : "RSI";
  if (metric.status === "none" || metric.baseline === null || metric.currentWeek === null) {
    line.textContent = `${label} · need 3 prior weeks for baseline`;
    return line;
  }
  const weekVal =
    metric.metric === "heightIn"
      ? formatHeightIn(metric.currentWeek.mean)
      : metric.metric === "gctMs"
        ? formatMilliseconds(metric.currentWeek.mean)
        : formatRsi(metric.currentWeek.mean);
  const baseVal =
    metric.metric === "heightIn"
      ? formatHeightIn(metric.baseline)
      : metric.metric === "gctMs"
        ? formatMilliseconds(metric.baseline)
        : formatRsi(metric.baseline);
  const pct =
    metric.percentChange === null
      ? "—"
      : `${metric.percentChange >= 0 ? "+" : ""}${metric.percentChange.toFixed(1)}%`;
  const flag =
    metric.status === "established" ? formatFlag(metric.flag) : "no flag (provisional)";
  line.textContent = `${label} · week ${weekVal} vs base ${baseVal} · ${pct} · ${flag}`;
  return line;
}

function renderHistory(): void {
  const trials = loadTrials(localStorage);
  const metric = chartMetric.value as SessionMetric;
  const typeValue = chartJumpType.value;
  const jumpType = typeValue === "all" ? undefined : (typeValue as JumpType);
  const series = metricByDate(trials, metric, jumpType);
  const { svg, legend } = renderBoxChart(series, metric);
  chartRoot.replaceChildren(svg);
  chartLegend.replaceChildren();
  if (legend.length === 0) {
    chartLegend.textContent = "No saved jumps yet — chart stays empty until you save.";
    return;
  }
  const title = document.createElement("span");
  title.textContent = `${metricLabel(metric)} · mean by date`;
  chartLegend.append(title);
  for (const entry of legend) {
    const item = document.createElement("span");
    item.className = "chart-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "chart-swatch";
    swatch.style.background = entry.color;
    item.append(swatch, document.createTextNode(`${entry.boxHeightIn} in`));
    chartLegend.append(item);
  }
}

function renderTrial(trial: TrialRecord): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "jump jump-card";

  const when = document.createElement("p");
  when.className = "when";
  when.textContent = formatWhen(trial.createdAt);

  const title = document.createElement("p");
  title.className = "jump-card-title";
  title.textContent = `${formatJumpType(trial.jumpType)} · ${formatBoxInches(trial.boxHeightIn)}`;

  const meta = document.createElement("p");
  meta.className = "notes";
  meta.textContent = formatArmSwing(trial.armSwing);

  const grid = document.createElement("div");
  grid.className = "jump-metric-grid";
  for (const [label, value] of [
    ["Height", formatHeightIn(trial.heightIn)],
    ["Contact", formatMilliseconds(trial.gctMs)],
    ["Flight", formatMilliseconds(trial.flightMs)],
    ["RSI", formatRsi(trial.rsi)],
  ] as const) {
    const cell = document.createElement("div");
    const dt = document.createElement("span");
    dt.className = "jump-metric-label";
    dt.textContent = label;
    const dd = document.createElement("span");
    dd.className = "jump-metric-value";
    dd.textContent = value;
    cell.append(dt, dd);
    grid.append(cell);
  }

  item.append(when, title, meta, grid);
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
    void persistJumpLog(next).then(() => renderTrials());
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
