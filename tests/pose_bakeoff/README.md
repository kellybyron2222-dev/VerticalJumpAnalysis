# Pose model bakeoff (approach TO/LD)

Measurement-only harness comparing MediaPipe lite (app baseline) vs:

- **YOLO11n-pose** (COCO ankles, ONNX via Ultralytics)
- **RTMPose BodyWithFeet / Halpe26** (heel+toe, `rtmlib` + ONNX Runtime)

Ground contact ignores left/right labels (lowest foot keypoint). Flight =
longest airborne streak between floor-contact windows (same idea as
`src/approachDetect.ts`).

```bash
python3 tests/pose_bakeoff/run.py
python3 tests/pose_bakeoff/run.py --models yolo --clips clip0,clip3
```

Gates: plant TO/LD ±3 frames, flight ±25 ms, height ±1.0 in. Plant TD is info-only.
Results: `tests/pose_bakeoff/results.json`.
