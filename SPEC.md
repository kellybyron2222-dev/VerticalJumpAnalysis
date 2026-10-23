# Jump Lab — product spec

Mobile-first web app for one athlete, Byron, to analyze drop jumps and depth jumps filmed on an iPhone in slow motion (default 240 fps).

Future work should follow this document. Do the milestones in order. Finish and verify a milestone before starting the next one.

## Status

Milestone 1 is implemented: camera guide, local video, frame stepping, manual marks, provisional metrics, and on-phone trial storage. Milestone 2 is implemented (MediaPipe Pose Landmarker, per-frame image mode on CPU, every presentation frame of the chosen file; marks stay hand-correctable) but has not been verified on real iPhone clips. Milestone 3 is implemented: each saved clip is one jump (numbers only in localStorage), today’s session groups by jump type and box height with mean/best, and a date chart with one series per box height. Milestone 4 is implemented: weekly means vs prior-week baseline (provisional at 3+, established rolling-6 at 6+), CV noise, flags, manual re-baseline, raise-box ready/hold, box-profile retest reminder, and an optimal Box test (3–5 heights, tagged jumps, RSI/contact recommendation saved as working box; doubles as the 4-week retest). Milestone 5 is a Master log (all jumps, sortable, edit/delete) with Excel (.xlsx) and CSV export for paste into the Jump Test workbook, plus optional GitHub Contents sync of the same log onto a `data` branch (fine-grained token in localStorage only — no Microsoft/MSAL).

Slow-mo timing fix (after Milestone 2): see "Slow-mo playback and real time" below. Also built with Milestone 3: selectable box height (video estimate is cross-check only), sanity warnings, and plain metric labels.

## Slow-mo playback and real time

iPhone slo-mo clips picked from the camera roll often arrive stretched in time: a 240 fps capture plays at 30 fps, so media time runs 8× slower than real time. Durations read from `currentTime` are then inflated (8× GCT and flight, 64× height, 8× RSI).

- One conversion for every metric and the clock: the difference of the two frames' presentation timestamps, divided by the slow-mo stretch. Those timestamps come from the file's composition times (`stts` / `ctts` / edit list), which match `currentTime`. A file whose holds are about 1/60 s and 1/30 s is iPhone slo-mo playback: the capture rate is four times the playback average (about 170 fps when playback reads about 43). Photos' fps is that capture rate. Metrics apply that 4× even if the stretch chip still reads 1× — leaving playback time uncorrected is what produced ~230 in jumps. The stretch chips start on the detected factor. A free-fall time outside about 0.11–0.45 s is flagged and does not block auto-detect. Auto-detect pulls step-off back by the visible drop, because the first half of a free fall is too small to see.
- The stretch chips (1×, 2×, 4×, 8×) stay at 1 unless Byron taps one. They do not move marks.
- On load the app reads the file's sample table and does not play the clip to discover timestamps. `requestVideoFrameCallback` is only a fallback, and a hung or empty read leaves stepping and auto-detect enabled. A fallback `mediaTime` that sits past the played duration is shifted onto that duration.
- Sanity warning when jump height is over 40 in or under 2 in, contact time is outside 80–1000 ms, or the jump height and the box-height estimate disagree (jump more than 6× the box estimate, or the box estimate more than 8× the jump). A ramp stretches the drop and the flight by different amounts, so those two heights stop matching.

## Box height (selected, not from video)

- Jump Analysis has a box height selector: 6, 8, 10, 12, 14, 16, 18 in, plus Custom. The selected value is what is saved on each jump (and multi-jump set), used for session/chart grouping, baseline, and raise-box. It is remembered in localStorage; default is 6 in for drop jumps.
- A fourth, optional mark: step-off, the last frame with both feet on the box. Auto-detect finds it from the pose; it is hand-correctable like the other marks.
- Free-fall from step-off can still compute a video box-height estimate (`g × t² / 2`), shown only as a small greyed cross-check (`video estimate ~X in, not used`). It must not pre-fill the selector or drive saved jumps, charts, baseline, raise-box, or the Optimal Box Height test.

## UI wording

- The UI says "jump", never "trial". Code identifiers may keep `trial`.
- Readout labels: "Jump height (in)", "Contact time (ms)", "Flight time (ms)", "RSI". RSI is shown as a unitless ratio. The Excel export (Milestone 5) keeps "RSI (m/s)".

## Profiles (local)

- Local-only profile switcher (name, create, rename, switch, delete with confirm) in the menu. Active profile name is shown on every screen.
- App opens on the **Profiles** screen for first-time visitors, when nobody has logged in yet, or when the last login is older than 12 hours (shared phone). Tap a profile name to log in and continue. Optional circle photo per profile (camera roll / files; resized and stored on-device only); initials shown when no photo.
- Each profile has its own saved jumps, settings (baseline, box height, jumps-in-clip, chart mode, GCT target, working box), and master log — namespaced in `localStorage` under that profile id.
- Existing pre-profile data migrates into a default profile named **Byron** without loss. GitHub token/sync stay bound to Byron’s profile only (`allowGithub`). A new profile starts empty and cannot use GitHub sync.
- Each profile exports its own CSV/xlsx. Unit tests cover namespacing, migration, isolation from Byron’s data/GitHub log, and the login gate.

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

Auto-detect (on-device only; video never uploads):

- Default MediaPipe Pose Landmarker **lite** model. Optional **High accuracy** toggle lazy-loads the **heavy** model and re-scans; the UI must say it is slower.
- Floor-contact candidates are cross-checked with a **foot-speed** foot-strike detector: smooth ankle/heel/toe vertical position, vertical velocity in real time (after slow-mo stretch correction), touchdown when downward speed drops to ~0 and the foot stays still, takeoff when upward speed first exceeds a threshold after contact, landing at the **first** sustained foot-speed stop after takeoff (not a later settle). Prefer cycles consistent with both paths.
- **Jumps in this clip** selector: Auto / 1 / 2 / 3 / 4 (remembered; default Auto). Fixed N returns exactly the N best-scoring valid cycles in time order (N=1 → single jump, no multi-jump panel). Auto may find 1–4.
- In Auto, drop a cycle as a rep when height < 4 in, RSI < 0.5, or height < 40% of the best cycle; require a real drop/step-off (meaningful free-fall) or mid-drop/countermovement — not a 1-frame fake step-off from walking/settling. Prefer under-detecting over inventing a second jump.
- Flag (do not hide) any cycle with flight > 650 ms real or height > 30 in: "check LD mark: landing may be late".
- Soft self-check: when a chosen cycle has contact outside 100–600 ms real or flight outside 150–800 ms, show a clear **Check marks** flag and keep manual Set/Go-to controls prominent (do not hide the jump).
- Pose scan: decode frames capped ~480px on the long side before MediaPipe, reuse one canvas buffer, yield to the UI during the scan, and show a progress bar with ETA. Timing math is unchanged.
- After a successful auto-detect, optional **foot path overlay** (toggle) drawn by one shared `drawFootOverlay` path for on-screen display, PNG jump card, and exported video: dark-gray (`#3a3a3a`) foot-path line and foot points (~50% thicker), dark-blue (`#1a2a6c`) labels with light semi-transparent backing. Horizontal **takeoff** line at the lowest foot (floor/toe-off), **apex** line at that foot’s peak height, vertical bracket between them labeled with the app’s official flight-time jump height — visual guide only (do not scale/fake from pixel displacement; metrics table stays the official number). **Export jump card** / **Export video** use that same overlay (video: canvas `captureStream` + `MediaRecorder`, prefer `video/mp4`, fall back to webm; step-off through a bit after landing; selectable 1× / 0.5× / 0.25× real-time slow-mo; progress; `navigator.share` or Save/download). On-device only; no upload; timing math unchanged. Cancelling the iOS share sheet (`AbortError`) is silent for card and video export.
- Keep real-time plausibility gates: contact 80–1000 ms, flight ≥150 ms. If no plausible jump is found, say so and fall back to manual frame marking — never apply nonsense marks.

### Milestone 3 — Metrics, sessions, and box profile

Done when all of the following work:

Definitions (frame index is the source of truth; fps converts frames to time):

- Ground contact time: `GCT = takeoff − touchdown`, in milliseconds.
- Flight time: `FT = landing − takeoff`, in milliseconds.
- Jump height from flight time: `height = g × FT² / 8`, shown in inches and centimeters. `FT` in this formula is in seconds. Use a single named gravity constant everywhere (`9.80665 m/s²`).
- Reactive strength index: `RSI = height (m) / GCT (s)`.

Behavior:

- Each analyzed clip saves as one jump (local numbers only): date, jump type, box height (from the selector), contact time, flight time, jump height, RSI.
- Group the day’s jumps by jump type and box height. Show mean and best for each metric (target 3 jumps per session / box).
- Chart jump height, contact time, and RSI by box height over weeks/sessions (simple SVG; readable on phone). Toggle **Mean by date / Every jump** (remembered; default mean by date). Every-jump mode plots each saved jump as its own dot (same box-height colors/legend).
- Unit tests cover session grouping and aggregation.

### Milestone 4 — Baseline and flags

Done when all of the following work (per jump type + box height, for height, contact time, and RSI):

- Weekly mean = mean of that week’s jumps; keep the best as a PR.
- Compare the current week’s mean with the average of prior weekly means only (exclude the current week).
- Provisional baseline at 3+ prior weeks: show the comparison, do not flag.
- Established baseline at 6+ prior weeks: rolling average of the last 6 prior weeks; flags apply.
- Manual “re-baseline from this week” cuts older weeks out of the baseline pool.
- Noise = athlete CV of weekly means once 3+ weeks exist; default CV 8.5% until then.
- Flags (established only): |delta| < 1× CV normal; 1–2× CV watch; > 2× CV, or > 1× CV in the same direction for 2 consecutive weeks, real change. Contact time: lower is better; streak uses signed direction.
- Session view shows this week vs baseline, % change, flag, and provisional/established status.
- Pure baseline helpers live in their own module with unit tests.
- Raise-box indicator (per jump type + box): ready when RSI weekly mean is > 1× CV above baseline for 2 consecutive weeks and contact-time weekly mean is ≤ target (default 250 ms, editable) in both weeks; show hold if contact is above target or trending up (watch/real in the worse direction).
- Box-profile retest reminder when 4+ weeks have passed since the last day that tested 3+ different box heights.
- Raise-box / retest helpers are pure functions with unit tests.
- Optimal Box test mode (drop or depth) is self-contained: 3–5 height rows (default 6/12/18/24), upload one clip per height on that screen (auto-detect + metrics inline, compact mark nudge), Submit when 3+ heights have results. Recommend highest RSI with mean contact ≤ target (shared 250 ms); within 1× CV pick the lower box; if none meet target, suggest the lowest. Chart + save working box; jumps tagged with test id. Counts toward the 4-week profile retest. Pure helpers + unit tests.

### Milestone 5 — Master log + Excel/CSV export + GitHub log sync

Done when:

- Menu screen **Master log** lists every saved jump (drop, depth, box-test) in a sortable table: Date, Week, Jump type, Box (in), Arm swing, Height (in), GCT (ms), Flight (ms), RSI, Test id, Notes; edit and delete supported.
- **Export to Excel** downloads a real `.xlsx` (SheetJS) with separate **Drop jump** and **Depth jump** sheets (paste columns only: Date, Week, Box, Arm swing, Height (in), GCT (ms), RSI (m/s), Notes). **Export CSV** uses the same two sections. Download uses the share sheet / Save to Files path on iOS Safari when available. The GitHub sync CSV keeps the full multi-column log shape unchanged.
- Export columns: Date, Week, Box, Arm swing, Height (in), GCT (ms), RSI (m/s), Notes (Jump Test paste order), then Jump type, Flight (ms), Test id.
- No Microsoft login, MSAL, or Graph. Unit tests cover row mapping.
- **GitHub jump log (source of truth):** fine-grained PAT (Contents read/write on this repo only) stored in localStorage only — never committed or logged. Directions explain how to create the token. On load (when a token is set) the app fetches the remote log; localStorage is only a cache/outbox. Every save/edit/delete writes the full log immediately via GitHub REST Contents API (`PUT …/contents/data/jump-log.csv` and `data/jump-log.json`) on branch `data` (created from `main` if missing) so log commits do not trigger Pages on `main`. Sha retry; dirty outbox shows **Pending sync**; **Sync now** + last-synced status; empty-remote heal and mid-sync re-read so CSV includes rows. UI: “Saved to your jump log” / “Saved, will sync”; section **Jump log**. Unit tests cover CSV rows, merge, heal, and mid-sync PUT.

### Milestone 6 — Multi-jump clips

Done when:

- Auto-detect finds several jumps in one clip (step-off / touchdown / takeoff / landing cycles), splitting on standing periods; coarse scan then refine for long clips with progress.
- Per-jump results with nudge, include toggle, set summary (mean/best); save included jumps tagged with `setId`.
- Warn when a jump falls outside the slowed (high-capture-rate) section.
- Single-jump clips keep the previous one-mark UI path. Unit tests cover multi segmentation and slowed-region detection from PTS.

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
