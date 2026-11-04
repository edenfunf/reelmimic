#!/usr/bin/env python3
"""compare.py — put every shot of our film next to the reference shot it was planned from, with the numbers that matter.

    python compare.py <project_dir> [--video out/video.mp4]

Reads <project>/analysis/report.json (reference, from analyze.py) and <project>/plan.json (each shot's "ref_shot": the
reference shot number it maps to, and start_s/end_s). Analyses our video with the same measurements, then writes:
    out/check/compare_<id>.jpg   reference frames (top row) vs ours (bottom row), 3 moments each, with the stats
    out/check/compare.json       per shot: reference vs ours — camera kind/pace/speed, brightness, contrast, dark ratio, colourfulness
    out/check/compare_all.jpg    every pair at mid-shot on one sheet
    out/check/style_distance.json  measured distance (perception/): scores per component and shot + findings in words
                                   (fitted eases, move timing, tension peaks, cut/beat phase, cadence, colour)
    out/check/fingerprint_overlay.png  reference tension and camera speed time-warped onto ours
Open the images and score each shot (see the engine skill's Review section). Numbers flag, eyes decide.
"""
import argparse, json, os, sys
from pathlib import Path
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import shot_details  # same measurements for both films


def grab(path, t, w=480):
    cap = cv2.VideoCapture(path); cap.set(cv2.CAP_PROP_POS_MSEC, max(0, t) * 1000); ok, f = cap.read(); cap.release()
    if not ok: return np.zeros((round(w * 9 / 16), w, 3), np.uint8)
    return cv2.resize(f, (w, round(w * f.shape[0] / f.shape[1])))


def fit(img, w, h):
    canvas = np.zeros((h, w, 3), np.uint8); s = min(w / img.shape[1], h / img.shape[0])
    im = cv2.resize(img, (max(1, int(img.shape[1] * s)), max(1, int(img.shape[0] * s))))
    y, x = (h - im.shape[0]) // 2, (w - im.shape[1]) // 2; canvas[y:y + im.shape[0], x:x + im.shape[1]] = im; return canvas


def label(img, text, y=18):
    cv2.rectangle(img, (0, y - 16), (img.shape[1], y + 6), (0, 0, 0), -1)
    cv2.putText(img, text, (6, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (235, 235, 235), 1, cv2.LINE_AA); return img


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("project"); ap.add_argument("--video", default="out/video.mp4")
    a = ap.parse_args(); P = a.project
    rep = json.loads(Path(P, "analysis", "report.json").read_text(encoding="utf-8"))
    plan = json.loads(Path(P, "plan.json").read_text(encoding="utf-8"))
    ref_video = os.path.join(P, "analysis", rep.get("analysed", "source.mp4"))
    if not os.path.exists(ref_video): ref_video = os.path.join(P, "analysis", "source.mp4")
    ours = os.path.join(P, a.video)
    ref_shots = {d["shot"]: d for d in rep.get("shot_details", [])}
    spans = [[s["start_s"], s["end_s"]] for s in plan["shots"]]
    our_d = shot_details(ours, spans, spans[-1][1])
    out_dir = os.path.join(P, "out", "check"); os.makedirs(out_dir, exist_ok=True)
    W, H = 400, 225; rows = []; result = []
    for s, od in zip(plan["shots"], our_d):
        rn = s.get("ref_shot"); rd = ref_shots.get(rn)
        top, bot = [], []
        for k in (0.2, 0.5, 0.8):
            t_o = s["start_s"] + (s["end_s"] - s["start_s"]) * k; bot.append(fit(grab(ours, t_o, W), W, H))
            if rd: top.append(fit(grab(ref_video, rd["start"] + (rd["end"] - rd["start"]) * k, W), W, H))
            else: top.append(np.full((H, W, 3), 25, np.uint8))
        rl = rd and f"REF #{rn}  {'/'.join(rd['camera']['kind'])} {rd['camera']['pace']}  bright {rd['look']['brightness']}  dark {rd['look']['dark_ratio']}" or "REF: none mapped"
        ol = f"OURS {s['id']}  {'/'.join(od['camera']['kind'])} {od['camera']['pace']}  bright {od['look']['brightness']}  dark {od['look']['dark_ratio']}"
        top[0] = label(top[0], rl); bot[0] = label(bot[0], ol)
        pair = np.vstack([np.hstack(top), np.hstack(bot)])
        cv2.imwrite(os.path.join(out_dir, f"compare_{s['id']}.jpg"), pair, [cv2.IMWRITE_JPEG_QUALITY, 88])
        rows.append(np.hstack([top[1], bot[1]]))
        result.append({"id": s["id"], "ref_shot": rn, "ref": rd and {"camera": rd["camera"], "look": rd["look"]}, "ours": {"camera": od["camera"], "look": od["look"]}})
    if rows:
        cv2.imwrite(os.path.join(out_dir, "compare_all.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
    Path(out_dir, "compare.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in result:
        rc, oc = (r["ref"] or {}).get("camera", {}), r["ours"]["camera"]
        flag = "" if not rc or rc.get("pace") == oc.get("pace") or (rc.get("pace") != "still" and oc.get("pace") != "still") else "  ← motion mismatch"
        print(f"{r['id']} ↔ ref #{r['ref_shot']}: ours {oc.get('kind')} {oc.get('pace')} vs ref {rc.get('kind')} {rc.get('pace')}{flag}")
    print("wrote", out_dir)
    try:   # the measured comparison: style_distance.json + fingerprint_overlay.png (perception/, docs/COMPILER.md)
        from perception.cli import project, report
        print(report(project(P, a.video)))
    except Exception as e:
        print("style distance skipped:", e)


if __name__ == "__main__":
    main()
