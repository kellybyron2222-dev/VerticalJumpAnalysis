# Jump Lab — product spec

Mobile-first web app for one athlete, Byron, to analyze drop jumps and depth jumps filmed on an iPhone in slow motion (default 240 fps).

Future work should follow this document. Do the milestones in order. Finish and verify a milestone before starting the next one.

## Status

Milestone 1 is implemented: camera guide, local video, frame stepping, manual marks, provisional metrics, and on-phone trial storage. Milestone 2 is implemented (MediaPipe Pose Landmarker, per-frame image mode on CPU, every presentation frame of the chosen file; marks stay hand-correctable) but has not been verified on real iPhone clips. Milestone 3 is implemented: each saved clip is one jump (numbers only in localStorage), today’s session groups by jump type and box height with mean/best, and a simple box-height chart (height, contact time, RSI by week). Milestones 4–5 are specified below and are not built.

Slow-mo timing fix (after Milestone 2): see "Slow-mo playback and real time" below. Also built with Milestone 3: box height estimated from video, sanity warnings, and plain metric labels.

## Slow-mo playback and real time

iPhone slo-mo clips picked from the camera roll often arrive stretched in time: a 240 fps capture plays at 30 fps, so media time runs 8× slower than real time. Durations read from `currentTime` are then inflated (8× GCT and flight, 64× height, 8× RSI).

- One conversion for every metric and the clock: the difference of the two frames' presentation timestamps, divided by the slow-mo stretch. Those timestamps come from the file's composition times (`stts` / `ctts` / edit list), which match `currentTime`. A file whose holds are about 1/60 s and 1/30 s is iPhone slo-mo playback: the capture rate is four times the playback average (about 170 fps when playback reads about 43). Photos' fps is that capture rate. Metrics apply that 4× even if the stretch chip still reads 1× — leaving playback time uncorrected is what produced ~230 in jumps. The stretch chips start on the detected factor. A free-fall time outside about 0.11–0.45 s is flagged and does not block auto-detect. Auto-detect pulls step-off back by the visible drop, because the first half of a free fall is too small to see.
- The stretch chips (1×, 2×, 4×, 8×) stay at 1 unless Byron taps one. They do not move marks.
- On load the app reads the file's sample table and does not play the clip to discover timestamps. `requestVideoFrameCallback` is only a fallback, and a hung or empty read leaves stepping and auto-detect enabled. A fallback `mediaTime` that sits past the played duration is shifted onto that duration.
- Sanity warning when jump height is over 40 in or under 2 in, contact time is outside 80–1000 ms, or the jump height and the box-height estimate disagree (jump more than 6× the box estimate, or the box estimate more than 8× the jump). A ramp stretches the drop and the flight by different amounts, so those two heights stop matching.

## Box height from video

- A fourth, optional mark: step-off, the last frame with both feet on the box. Auto-detect finds it from the pose (the higher foot reaching box level, read from the first tenth of the clip, with a tight tolerance); it is hand-correctable like the other marks.
- Free fall: airborne frames `stepOff + 1 … touchdown − 1`, so `t = (touchdown − stepOff − 1) / capture fps / slowMoFactor`, and `box height = g × t² / 2`.
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

Done when all of the following work:

Definitions (frame index is the source of truth; fps converts frames to time):

- Ground contact time: `GCT = takeoff − touchdown`, in milliseconds.
- Flight time: `FT = landing − takeoff`, in milliseconds.
- Jump height from flight time: `height = g × FT² / 8`, shown in inches and centimeters. `FT` in this formula is in seconds. Use a single named gravity constant everywhere (`9.80665 m/s²`).
- Reactive strength index: `RSI = height (m) / GCT (s)`.

Behavior:

- Each analyzed clip saves as one jump (local numbers only): date, jump type, box height (auto-measured, editable), contact time, flight time, jump height, RSI.
- Group the day’s jumps by jump type and box height. Show mean and best for each metric (target 3 jumps per session / box).
- Chart jump height, contact time, and RSI by box height over weeks/sessions (simple SVG; readable on phone).
- Unit tests cover session grouping and aggregation.

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

### Later — Multi-jump clips (after Excel)

After Milestone 5 export works: support sets of 1–4 jumps in one clip. Split each jump from its step-off; warn if a jump falls outside the slowed section of the file.

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
