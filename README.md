# Jump Lab

Mobile-first app for marking drop jumps and depth jumps from iPhone slo-mo video. It runs entirely in the browser. The video stays on the phone; trials are numbers in `localStorage`.

This repo is Milestone 1 of [SPEC.md](SPEC.md): load a clip, step by frame, mark touchdown / takeoff / landing, and save the trial. Later milestones (pose detection, baselines, Excel export) are specified and not built.

## Run locally

Node 22 or newer.

```bash
npm install
npm test
npm run dev
```

Open the URL Vite prints (port 4731). On an iPhone, use the Network address, not `localhost`.

## Trial math

Ground contact time is takeoff minus touchdown. Flight time is landing minus takeoff. Jump height is `g × flightTime² / 8` with `g = 9.80665 m/s²`. RSI is height in meters divided by contact time in seconds. `npm test` covers that math, the frame-seek timing, and local storage.

## Phone

- The camera guide opens on every launch. Menu → Camera setup brings it back. It is not part of marking a trial.
- Choose a video from the camera roll. Seeking uses `playsinline` and waits for `seeked`.
- Default frame rate is 240. Change it if the clip was recorded at another rate.
- Arrow keys step one frame on a keyboard. Shift plus an arrow steps ten.

## Deploy

Static build, no server:

```bash
npm test
npm run build
```

Upload the `dist/` folder to any static host.

GitHub Pages:

- User site (`https://<user>.github.io/`): `base` stays `/`.
- Project site (`https://<user>.github.io/<repo>/`): build with `VITE_BASE=/<repo>/ npm run build`, then publish `dist/`.

`vite.config.ts` reads `VITE_BASE` and defaults to `/`.
