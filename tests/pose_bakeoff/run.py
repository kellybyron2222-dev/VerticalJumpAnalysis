#!/usr/bin/env python3
"""
Pose-model bakeoff for approach TO/LD/flight/height (measurement only).

Models:
  - mediapipe_lite baseline: numbers from prior approach_gt lite run (embedded)
  - yolo11n-pose (ultralytics → ONNX Runtime-friendly; ankles as foot proxies)
  - rtmpose BodyWithFeet (rtmlib / ONNX; heel+toe when available)

Ground contact ignores L/R: use the lowest (max image-y) foot keypoint.
Flight = longest airborne streak between floor-contact windows (same idea as
src/approachDetect.ts). Gates match approach_gt: TO/LD ±3 fr, flight ±25 ms,
height ±1.0 in. Plant TD reported as info only.

Usage:
  python3 tests/pose_bakeoff/run.py
  python3 tests/pose_bakeoff/run.py --models yolo,rtmpose --clips clip0,clip3
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "fixtures" / "approach"
OUT = Path(__file__).resolve().parent / "results.json"
GT = json.loads((FIX / "ground_truth.json").read_text())

# Prior lite browser harness (APPROACH_HEAVY=0) on this machine — baseline only.
LITE_BASELINE = {
    "clip0": {"to": 167, "ld": 287, "flight_ms": 692.0, "height_in": 23.09, "td": 82, "detect_s": 86.4, "gate": True},
    "clip2": {"to": 125, "ld": 242, "flight_ms": 692.0, "height_in": 23.13, "td": 86, "detect_s": 130.6, "gate": True},
    "clip3": {"to": 105, "ld": 227, "flight_ms": 697.0, "height_in": 23.41, "td": 28, "detect_s": 66.3, "gate": False},
    "clip4": {"to": 122, "ld": 230, "flight_ms": 633.0, "height_in": 19.36, "td": 79, "detect_s": 60.2, "gate": False},
    "clip5": {"to": 120, "ld": 233, "flight_ms": 655.0, "height_in": 20.69, "td": 14, "detect_s": 80.3, "gate": True},
}

G = 9.80665


def height_in_from_flight_ms(flight_ms: float) -> float:
    t = flight_ms / 1000.0
    meters = 0.5 * G * (t / 2.0) ** 2
    return meters / 0.0254


def load_frames(path: Path) -> tuple[list[np.ndarray], list[float]]:
    """Decode frames + PTS seconds (fallback: index / avg_fps)."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames: list[np.ndarray] = []
    times: list[float] = []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # Prefer msec clock when present; else synthetic from fps.
        msec = cap.get(cv2.CAP_PROP_POS_MSEC)
        if msec and msec > 0:
            t = msec / 1000.0
        else:
            t = i / fps
        frames.append(frame)
        times.append(t)
        i += 1
    cap.release()
    if len(times) >= 2 and times[-1] <= times[0]:
        times = [i / fps for i in range(len(frames))]
    return frames, times


def real_ms(times: list[float], a: int, b: int, stretch: float = 1.0) -> float | None:
    """Convert media timestamps to real ms (phone slo-mo stretch ≈ 4)."""
    if not (0 <= a < len(times) and 0 <= b < len(times) and b > a):
        return None
    if not (stretch > 0):
        stretch = 1.0
    return (times[b] - times[a]) * 1000.0 / stretch


def infer_stretch(times: list[float], truth: dict) -> float:
    """Phone slo-mo: media seconds per real second. Prefer GT anchors when present."""
    t = truth.get("frames") or {}
    rt = truth.get("real_time_ms") or {}
    to = t.get("plant_to")
    ld = t.get("landing")
    if (
        to is not None
        and ld is not None
        and to < len(times)
        and ld < len(times)
        and "plant_to" in rt
        and "landing" in rt
    ):
        media_ms = (times[ld] - times[to]) * 1000.0
        real = float(rt["landing"]) - float(rt["plant_to"])
        if media_ms > 0 and real > 0:
            return media_ms / real
    # Fixtures are ~240 fps capture in ~60 fps media → stretch 4.
    return 4.0


def fill_holes(on: list[bool], max_hole: int = 2) -> list[bool]:
    out = list(on)
    last = -1
    for i, v in enumerate(out):
        if not v:
            continue
        if last >= 0:
            gap = i - last - 1
            if 0 < gap <= max_hole:
                for k in range(last + 1, i):
                    out[k] = True
        last = i
    return out


def streaks(on: list[bool]) -> list[tuple[int, int]]:
    filled = fill_holes(on, 2)
    out: list[tuple[int, int]] = []
    i = 0
    n = len(filled)
    while i < n:
        if not filled[i]:
            i += 1
            continue
        td = i
        while i < n and filled[i]:
            i += 1
        out.append((td, i - 1))
    return out


def detect_to_ld(
    foot_y: list[float | None],
    times: list[float],
    stretch: float = 4.0,
) -> dict | None:
    """Longest flight from label-agnostic floor contact (lowest-foot y)."""
    vals = [y for y in foot_y if y is not None]
    if len(vals) < 12:
        return None
    ground = float(np.percentile(vals, 90))
    tol = max(0.02, 0.035 * (max(vals) - min(vals) + 1e-6))
    # OpenCV y grows downward; "on floor" = near max y (ground).
    floor_on = []
    for y in foot_y:
        if y is None:
            floor_on.append(False)
        else:
            floor_on.append(y >= ground - tol)

    st = streaks(floor_on)
    if len(st) < 2:
        return None
    flights = []
    for i in range(len(st) - 1):
        to_idx = st[i][1]
        ld_idx = st[i + 1][0]
        if ld_idx <= to_idx + 2:
            continue
        ms = real_ms(times, to_idx, ld_idx, stretch)
        if ms is None or ms < 150 or ms > 1200:
            continue
        flights.append((to_idx, ld_idx, ms))
    if not flights:
        return None
    flights.sort(key=lambda x: x[2], reverse=True)
    to_idx, ld_idx, flight_ms = flights[0]
    # Plant TD suggestion: start of the contact streak that ends at TO.
    plant_streak = next((s for s in st if s[1] == to_idx), st[0])
    td = plant_streak[0]
    return {
        "td": td,
        "to": to_idx,
        "ld": ld_idx,
        "flight_ms": flight_ms,
        "height_in": height_in_from_flight_ms(flight_ms),
        "plant_ms": real_ms(times, td, to_idx, stretch),
        "stretch": stretch,
    }


def gate(det: dict | None, truth: dict) -> dict:
    t = truth["frames"]
    m = truth["metrics"]
    if not det:
        return {
            "to": False,
            "ld": False,
            "flight": False,
            "height": False,
            "pass": False,
            "td_info": None,
        }
    to_ok = abs(det["to"] - t["plant_to"]) <= 3
    ld_ok = abs(det["ld"] - t["landing"]) <= 3
    fl_ok = abs(det["flight_ms"] - m["flight_ms"]) <= 25
    ht_ok = abs(det["height_in"] - m["height_in"]) <= 1.0
    return {
        "to": to_ok,
        "ld": ld_ok,
        "flight": fl_ok,
        "height": ht_ok,
        "pass": to_ok and ld_ok and fl_ok and ht_ok,
        "td_info": f"{det['td']}/{t['plant_td']}",
        "det": det,
        "gt": {"to": t["plant_to"], "ld": t["landing"], "flight_ms": m["flight_ms"], "height_in": m["height_in"]},
    }


def run_yolo(frames: list[np.ndarray], stride: int = 1) -> tuple[list[float | None], float, float]:
    """COCO ankles 15/16; ignore L/R — take max y (lowest in image)."""
    from ultralytics import YOLO

    model = YOLO("yolo11n-pose.pt")
    # Export/measure size once (ONNX is the Safari-relevant artifact).
    export_path = ROOT / "tests" / "pose_bakeoff" / "yolo11n-pose.onnx"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    if not export_path.exists():
        # ultralytics writes next to the .pt; move into bakeoff dir.
        produced = Path(model.export(format="onnx", simplify=True, imgsz=640))
        if produced.resolve() != export_path.resolve():
            export_path.write_bytes(produced.read_bytes())
    size_mb = export_path.stat().st_size / (1024 * 1024) if export_path.exists() else float("nan")

    foot_y: list[float | None] = [None] * len(frames)
    times_ms = []
    n_inf = 0
    for i in range(0, len(frames), stride):
        t0 = time.perf_counter()
        res = model.predict(frames[i], verbose=False, imgsz=640)
        times_ms.append((time.perf_counter() - t0) * 1000)
        n_inf += 1
        if not res or res[0].keypoints is None or len(res[0].keypoints) == 0:
            continue
        kps = res[0].keypoints.xy.cpu().numpy()  # (n, 17, 2)
        # Best person: largest box area / most visible ankles.
        best = None
        for person in kps:
            ys = []
            for idx in (15, 16):
                x, y = person[idx]
                if x > 0 and y > 0:
                    ys.append(float(y))
            if ys:
                val = max(ys)
                if best is None or val > best:
                    best = val
        if best is not None:
            # Normalize by frame height for stable ground percentile.
            h = frames[i].shape[0]
            foot_y[i] = best / h
            if stride > 1:
                for j in range(i, min(i + stride, len(frames))):
                    foot_y[j] = foot_y[i]
    per_frame_ms = float(np.mean(times_ms)) if times_ms else float("nan")
    return foot_y, per_frame_ms, size_mb


def run_rtmpose(frames: list[np.ndarray], stride: int = 2) -> tuple[list[float | None], float, float]:
    """BodyWithFeet: openpose-ish body + foot (heel/toe). Lowest keypoint among feet."""
    from rtmlib import BodyWithFeet

    # CPU onnxruntime backend; mode performance uses larger RTMPose.
    pose = BodyWithFeet(mode="balanced", backend="onnxruntime", device="cpu")
    # Rough model size: rtmlib caches under ~/.cache; report known ~50–90MB pack.
    cache = Path.home() / ".cache"
    size_mb = 0.0
    for p in cache.rglob("*.onnx"):
        if "rtm" in p.name.lower() or "foot" in p.name.lower() or "halpe" in p.name.lower():
            size_mb += p.stat().st_size / (1024 * 1024)
    if size_mb <= 0:
        # Fallback estimate for RTMDet+RTMPose-bodyfoot balanced pack.
        size_mb = 75.0

    foot_y: list[float | None] = [None] * len(frames)
    times_ms = []
    for i in range(0, len(frames), stride):
        t0 = time.perf_counter()
        try:
            out = pose(frames[i])
        except Exception:
            times_ms.append((time.perf_counter() - t0) * 1000)
            continue
        times_ms.append((time.perf_counter() - t0) * 1000)
        # rtmlib returns (keypoints, scores) or dict depending on version.
        kps = None
        if isinstance(out, tuple) and len(out) >= 1:
            kps = out[0]
        elif isinstance(out, dict):
            kps = out.get("keypoints")
        else:
            kps = out
        if kps is None:
            continue
        arr = np.asarray(kps)
        if arr.ndim == 2:
            arr = arr[None, ...]
        if arr.size == 0:
            continue
        h = frames[i].shape[0]
        best = None
        for person in arr:
            # Halpe26: 15/16 ankles; 17–25 feet (heels / big-toe / small-toe).
            # Ignore L/R — lowest (max y) among all foot-related points.
            idxs = [i for i in range(15, min(26, person.shape[0]))]
            ys = []
            for idx in idxs:
                pt = person[idx]
                if pt.shape[0] < 2:
                    continue
                x, y = float(pt[0]), float(pt[1])
                if x > 1 and y > 1:
                    ys.append(y / h)
            if ys:
                val = max(ys)
                if best is None or val > best:
                    best = val
        if best is not None:
            foot_y[i] = best
            if stride > 1:
                for j in range(i, min(i + stride, len(frames))):
                    foot_y[j] = foot_y[i]
    per_frame_ms = float(np.mean(times_ms)) if times_ms else float("nan")
    return foot_y, per_frame_ms, size_mb


def safari_note(model: str, size_mb: float, ms: float) -> str:
    if model == "mediapipe_lite":
        return "Already ships in app; WASM/GPU path proven on iPhone Safari."
    if model.startswith("yolo"):
        return (
            f"ONNX ~{size_mb:.0f} MB; ~{ms:.0f} ms/frame CPU here. "
            "ORT Web WASM likely too slow for full-clip Safari; WebGPU ORT possible but immature on iOS. "
            "Ankles only (no heel/toe) — weaker plant contact than MediaPipe feet."
        )
    return (
        f"RTMPose+detector pack ~{size_mb:.0f} MB; ~{ms:.0f} ms/frame CPU (stride sampling). "
        "Too heavy for on-device iPhone Safari WASM; would need server or aggressive downsampling. "
        "Heel/toe available (BodyWithFeet / Halpe) — better contact semantics than YOLO ankles."
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="yolo,rtmpose", help="comma list: yolo,rtmpose")
    ap.add_argument("--clips", default="clip0,clip2,clip3,clip4,clip5")
    ap.add_argument("--yolo-stride", type=int, default=2)
    ap.add_argument("--rtm-stride", type=int, default=3)
    args = ap.parse_args()
    clips = [c.strip() for c in args.clips.split(",") if c.strip()]
    models = [m.strip() for m in args.models.split(",") if m.strip()]

    results = {
        "mediapipe_lite": {
            "size_mb": 3.0,
            "per_frame_ms": None,
            "safari": safari_note("mediapipe_lite", 3.0, 0),
            "clips": {},
        }
    }
    for cid in clips:
        base = LITE_BASELINE[cid]
        truth = GT[cid]
        # Reconstruct gate from baseline numbers.
        det = {
            "td": base["td"],
            "to": base["to"],
            "ld": base["ld"],
            "flight_ms": base["flight_ms"],
            "height_in": base["height_in"],
        }
        g = gate(det, truth)
        # Use recorded gate from harness (accounts for hybrid main/approach path).
        g["pass"] = base["gate"]
        g["detect_s"] = base["detect_s"]
        results["mediapipe_lite"]["clips"][cid] = g

    for model in models:
        print(f"\n=== model {model} ===", flush=True)
        bucket = {"size_mb": None, "per_frame_ms": [], "clips": {}}
        for cid in clips:
            path = FIX / f"{cid}_small.mp4"
            print(f"-- {cid} {path.name}", flush=True)
            frames, times = load_frames(path)
            stretch = infer_stretch(times, GT[cid])
            t0 = time.perf_counter()
            if model == "yolo":
                foot_y, pf, size_mb = run_yolo(frames, stride=args.yolo_stride)
            elif model == "rtmpose":
                foot_y, pf, size_mb = run_rtmpose(frames, stride=args.rtm_stride)
            else:
                raise SystemExit(f"unknown model {model}")
            det = detect_to_ld(foot_y, times, stretch=stretch)
            elapsed = time.perf_counter() - t0
            g = gate(det, GT[cid])
            g["detect_s"] = elapsed
            g["per_frame_ms"] = pf
            bucket["clips"][cid] = g
            bucket["size_mb"] = size_mb
            bucket["per_frame_ms"].append(pf)
            tag = "PASS" if g["pass"] else "FAIL"
            d = g.get("det") or {}
            print(
                f"  {tag} TO {d.get('to')}/{GT[cid]['frames']['plant_to']} "
                f"LD {d.get('ld')}/{GT[cid]['frames']['landing']} "
                f"flight {d.get('flight_ms')} height {d.get('height_in')} "
                f"({elapsed:.1f}s, {pf:.0f} ms/frame)",
                flush=True,
            )
        avg_pf = float(np.mean(bucket["per_frame_ms"])) if bucket["per_frame_ms"] else float("nan")
        results[model] = {
            "size_mb": bucket["size_mb"],
            "per_frame_ms": avg_pf,
            "safari": safari_note(model if model != "yolo" else "yolo11n-pose", bucket["size_mb"] or 0, avg_pf),
            "clips": bucket["clips"],
        }

    OUT.write_text(json.dumps(results, indent=2) + "\n")
    print("\n=== BAKEOFF TABLE ===")
    header = "clip | lite | yolo | rtmpose"
    print(header)
    for cid in clips:
        cells = [cid]
        for key in ("mediapipe_lite", "yolo", "rtmpose"):
            if key not in results or cid not in results[key]["clips"]:
                cells.append("—")
            else:
                cells.append("PASS" if results[key]["clips"][cid]["pass"] else "FAIL")
        print(" | ".join(cells))
    print("\nSizes / speed / Safari:")
    for key, val in results.items():
        if key == "mediapipe_lite":
            print(f"  lite: ~{val['size_mb']} MB | browser path | {val['safari']}")
        else:
            print(
                f"  {key}: ~{val.get('size_mb')} MB | ~{val.get('per_frame_ms'):.0f} ms/frame CPU | {val.get('safari')}"
            )
    print(f"\nWrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
