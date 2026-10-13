# Jump Lab — product spec

Mobile-first web app for one athlete, Byron, to analyze drop jumps and depth jumps filmed on an iPhone in slow motion (default 240 fps).

Future work should follow this document. Do the milestones in order. Finish and verify a milestone before starting the next one.

## Status

Milestone 1 is implemented: camera guide, local video, frame stepping, manual marks, provisional metrics, and on-phone trial storage. Milestone 2 is implemented (MediaPipe Pose Landmarker, per-frame image mode on CPU, coarse scan then frame-by-frame refinement; marks stay hand-correctable) but has not been verified on real iPhone clips. Milestones 3–5 are specified below and are not built.

Slow-mo timing fix (after Milestone 2): see "Slow-mo playback and real time" below. Also built ahead of Milestone 3: box height estimated from video, sanity warnings, and plain metric labels.

## Slow-mo playback and real time

iPhone slo-mo clips picked from the camera roll often arrive stretched in time: a 240 fps capture plays at 30 fps, so media time runs 8× slower than real time. Durations read from `currentTime` are then inflated (8× GCT and flight, 64× height, 8× RSI).

- Frame indexes always count real captured frames. `frame / capture fps` is real seconds. All metrics use that.
- Two inputs: capture frame rate (default 240) and slow-mo playback factor (media seconds per real second; chips 1×, 4×, 8×, any value ≥ 1 allowed). Seeking uses `capture fps / factor` frames per media second.
- Auto-detect on load: play the clip muted at 0.2× and read `requestVideoFrameCallback` `mediaTime`/`presentedFrames`. A low quantile of the per-frame gaps is the clip's frame interval (dropped display frames only make gaps longer). Factor = capture fps ÷ clip fps, snapped to 1/2/4/8 within 15%. If the browser has no frame callbacks, the user picks the factor. A Detect button re-runs it.
- Changing the factor keeps existing marks on the same video moment (frames are rescaled by old factor ÷ new factor).
- Sanity warning when jump height is over 40 in or under 2 in, or contact time is outside 80–1000 ms.

## Box height from video

- A fourth, optional mark: step-off, the last frame with both feet on the box. Auto-detect finds it from the pose (the higher foot reaching box level, read from the first tenth of the clip, with a tight tolerance); it is hand-correctable like the other marks.
- Free fall: airborne frames `stepOff + 1 … touchdown − 1`, so `t = (touchdown − stepOff − 1) / capture fps`, and `box height = g × t² / 2`.
- Shown in inches and centimeters and labeled as an estimate. It pre-fills the box height field (rounded to 0.5 in) unless the user has typed or picked a value; the field stays editable.

## UI wording

- The UI says "jump", never "trial". Code identifiers may keep `trial`.
- Readout labels: "Jump height (in)", "Contact time (ms)", "Flight time (ms)", "RSI". RSI is shown as a unitless ratio. The Excel export (Milestone 5) keeps "RSI (m/s)".

## Constraints

- Static and client-side only. No backend, no account system, no server-side video processing.
- Must run in iPhone Safari. Desktop browsers are fine for development, but phone behavior is the bar.
- Videos stay on the phone. The app never uploads, stores, or persists video bytes. It stores numbers only, in `localStorage` or IndexedDB.
- Single user. Do not build auth, multi-athlete accounts, or cloud profiles.
- Deployable as a static site (for example GitHub Pages). Keep the stack as plain HTML/JS, or a Vite build that outputs static files.
- Accuracy and repeatability of the event frames matter more than automation speed or visual polish.

## Camera setup guide

A screen shown when the app opens. It is dismissible, and it is reachable again from the menu. It is not part of the analysis flow — opening a video, stepping frames, or saving a trial must not require re-reading it.

Recommendations to show:

- Side-on (sagittal) view.
- Tripod at about hip height, or the top of the box.
- About 3–4 m away.
- Camera perpendicular to the plane of the jump.
- 1× lens only. No digital zoom.
- Full body, the box, and the landing area all in frame.
- Good lighting.
- 240 fps slow motion.

## Milestones

Each milestone is done before the next one starts.

### Milestone 1 — Manual trials

Done when all of the following work:

- Load a video from the camera roll (`input` with `accept="video/*"`).
- Set the frame rate. Default 240 fps.
- Step frame by frame: −10, −1, +1, +10, plus a scrubber.
- Seeking is iOS-safe: `playsinline` (and the older inline attribute), and each seek waits for `seeked` before relying on the new frame. Rapid taps must not leave the playhead on an intermediate frame.
- Manually mark touchdown, takeoff, and landing on the current frame.
- Per trial, enter jump type (drop jump or depth jump), box height in inches, arm swing (yes/no), and notes.
- Show provisional metrics for the open trial once the three marks are valid: GCT, flight time, jump height (inches and centimeters), and RSI.
- Save trials locally. Video is not saved.
- Show the camera guide on open, and allow dismissing it.
- Unit tests cover the metric math.

Out of scope for this milestone: pose detection, baselines, flags, Excel export, OneDrive.

### Milestone 2 — Automatic events

Detect touchdown, takeoff, and landing in the browser with a pose model (MediaPipe Pose or MoveNet). The user can still correct each event by hand, frame by frame. Accuracy and repeatability matter most. A wrong automatic mark that is easy to correct is acceptable; a mark that drifts between identical runs is not.

### Milestone 3 — Metrics, sessions, and box profile

Definitions (frame index is the source of truth; fps converts frames to time):

- Ground contact time: `GCT = takeoff − touchdown`, in milliseconds.
- Flight time: `FT = landing − takeoff`, in milliseconds.
- Jump height from flight time: `height = g × FT² / 8`, shown in inches and centimeters. `FT` in this formula is in seconds. Use a single named gravity constant everywhere (`9.80665 m/s²`).
- Reactive strength index: `RSI = height (m) / GCT (s)`.

Behavior:

- Group trials by jump type and box height.
- Three trials per box per session. Track the session mean, and keep the best as a PR.
- Box-height analysis: show how each metric changes as box height changes.

### Milestone 4 — Baseline and flags

Per jump type and box height:

- Compare the current week's mean with the average of prior weeks only. Exclude the current week from that average.
- Provisional baseline once there are 3 or more prior weeks: show the comparison, and do not flag.
- Established baseline once there are 6 or more prior weeks, using a rolling 6-week average of those prior weeks.
- Allow a manual re-baseline.
- Noise is the athlete's own coefficient of variation of weekly means, once 3 or more weeks exist. Until then, default CV is 8.5%.
- Change rules, relative to that CV:
  - Under 1× CV: normal.
  - 1–2× CV: watch.
  - Over 2× CV, or over 1× CV for 2 consecutive weeks: a real change.
- Raise-box indicator: RSI stays above 1× CV for 2 weeks, and GCT is at the user's target (default 250 ms).
- Suggest retesting the full box profile about every 4 weeks.

### Milestone 5 — Excel, then optional OneDrive

Export rows that match the Friday drop-jumps section of the Jump Test tab in Byron's workbook.

Columns, in order:

| Date | Week | Box | Arm swing | Height (in) | GCT (ms) | RSI (m/s) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |

Export as CSV and as XLSX.

Later, and only after export works: optional live OneDrive sync via Microsoft Graph. This is last and remains optional. The app must still be fully usable with no Microsoft account.

## Hosting

- `npm run build` (or the equivalent static export) must produce files that can be served from any static host.
- GitHub Pages is the reference target. Document the local run, the production build, and the Pages setup in the README.
- For a project site (`https://<user>.github.io/<repo>/`), the Vite `base` must be `/<repo>/`. For a user site, `base` stays `/`.

## Storage

Persist trial numbers only. Suggested record, once Milestone 1 exists (later milestones may add fields, but must keep older records readable):

- id, createdAt
- fps
- jump type: `drop` or `depth`
- box height in inches
- arm swing: boolean
- notes
- touchdown, takeoff, and landing frame indexes
- derived GCT, flight time, height (m, in, cm), and RSI
- optional `slowMoFactor` (missing means 1) and `stepOffFrame`

Do not persist object URLs or video blobs.

## Non-goals

- Multi-user support, logins, or a database.
- Uploading video anywhere.
- Native iOS app, App Store build, or a required install step beyond “Add to Home Screen”.
- Automatic detection, baselines, workbook export, or OneDrive before their milestone.
