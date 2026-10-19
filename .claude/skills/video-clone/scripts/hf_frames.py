#!/usr/bin/env python3
"""Fast, shared frame grabber for HyperFrames projects (used by builders and reviewers).

Why: every `hyperframes snapshot` call bundles the project, launches Chrome and settles the page (~10 s alone, minutes when
several agents do it at once, and page-load timeouts under load). Agents used to call it once per crop, per shot, per retry.
This tool makes that cheap:
  * ONE snapshot call per request, however many times you ask for (all shots, all moments together);
  * crops are cut from the full-resolution frame with PIL — never a separate --zoom render;
  * frames are cached by the content of the build folder: asking again for an unchanged moment costs nothing;
  * at most N snapshot processes run machine-wide (lock files), so parallel agents queue instead of timing out;
  * automatic retry on the flaky "navigation timeout".

Usage (from anywhere):
  python hf_frames.py <build_dir> --at 12.4,13.0,15.25 --out <dir>                  → <dir>/t12.400.png …
  python hf_frames.py <build_dir> --at 12.4 --crop 1100,300,600,500 --tag face --out <dir>   → also t12.400_face.png
  python hf_frames.py <build_dir> --range 12.0:14.0:0.1 --out <dir> --sheet strip.jpg       → every 0.1 s + a contact sheet
Prints one output path per line. Times are global (composition) seconds.
"""
import argparse, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
from PIL import Image

MAX_PARALLEL = int(os.environ.get("HF_SNAPSHOT_SLOTS", "3"))
LOCK_DIR = os.path.join(tempfile.gettempdir(), "hf_snapshot_slots")
CACHE = os.path.join(tempfile.gettempdir(), "hf_frame_cache")


def build_hash(build):
    # Every file counts except the ones that can't change a frame: an allow-list of extensions missed .jpeg, .gif, .mp4,
    # .webm, .mjs… and handed reviewers stale frames after those changed.
    h = hashlib.sha1()
    for root, dirs, files in os.walk(build):
        dirs[:] = sorted(d for d in dirs if d not in ("node_modules", "renders", "snapshots", ".git", "out"))
        for f in sorted(files):
            if f.startswith(".") or f.endswith((".md", ".log")): continue   # .DS_Store, notes, logs
            p = os.path.join(root, f); st = os.stat(p)
            h.update(f"{os.path.relpath(p, build)}|{st.st_size}|{int(st.st_mtime_ns)}".encode())
    return h.hexdigest()[:16]


class Slot:
    def __enter__(self):
        os.makedirs(LOCK_DIR, exist_ok=True)
        while True:
            for i in range(MAX_PARALLEL):
                p = os.path.join(LOCK_DIR, f"slot{i}")
                try:
                    if os.path.exists(p) and time.time() - os.path.getmtime(p) > 900: os.remove(p)   # stale
                    self.fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY); self.p = p; return self
                except FileExistsError:
                    continue
            time.sleep(1.5)

    def __exit__(self, *a):
        os.close(self.fd); os.remove(self.p)


def snapshot(build, times, outdir):
    cmd = ["npx", "hyperframes@0.8.80", "snapshot", ".", "--at", ",".join(f"{t:.3f}" for t in times), "--no-end",
           "-o", outdir, "--describe", "false", "--timeout", "30000"]
    for attempt in range(3):
        if os.path.isdir(outdir): shutil.rmtree(outdir)
        with Slot():
            r = subprocess.run(cmd, cwd=build, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=(os.name == "nt"))
        frames = sorted(glob.glob(os.path.join(outdir, "frame-*.png")), key=lambda p: int(re.search(r"frame-(\d+)", p).group(1)))
        if r.returncode == 0 and len(frames) == len(times): return frames
        err = (r.stdout + r.stderr)[-1500:]
        if attempt == 2: sys.exit(f"snapshot failed after 3 tries:\n{err}")
        time.sleep(2 + attempt * 3)


def grab(build, times):
    """Full-resolution PNG path for every time, rendering only the ones not cached for this exact build content."""
    key = build_hash(build); cdir = os.path.join(CACHE, key); os.makedirs(cdir, exist_ok=True)
    want = {t: os.path.join(cdir, f"t{t:.3f}.png") for t in times}
    todo = sorted({t for t, p in want.items() if not os.path.exists(p)})
    for i in range(0, len(todo), 60):   # one Chrome for up to 60 frames
        chunk = todo[i:i + 60]
        tmp = tempfile.mkdtemp(prefix="hf_snap_")
        for t, fr in zip(chunk, snapshot(build, chunk, tmp)): shutil.move(fr, want[t])
        shutil.rmtree(tmp, ignore_errors=True)
    return [want[t] for t in times]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("build"); ap.add_argument("--at"); ap.add_argument("--range", help="start:end:step (global seconds)")
    ap.add_argument("--crop", action="append", default=[], help="x,y,w,h (repeatable; applied to every time)")
    ap.add_argument("--tag", action="append", default=[]); ap.add_argument("--out", required=True)
    ap.add_argument("--sheet", help="also write a contact sheet with this file name"); ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--prefix", default="t")
    a = ap.parse_args()
    build = os.path.abspath(a.build)
    times = [float(x) for x in a.at.split(",")] if a.at else []
    if a.range:
        s, e, st = (float(x) for x in a.range.split(":")); n = int(round((e - s) / st)) + 1
        times += [round(s + i * st, 3) for i in range(n)]
    if not times: sys.exit("give --at or --range")
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time(); paths = grab(build, times); outs = []
    for t, p in zip(times, paths):
        dst = os.path.join(a.out, f"{a.prefix}{t:.3f}.png"); shutil.copy(p, dst); outs.append(dst); print(dst)
        for k, c in enumerate(a.crop):
            x, y, w, h = (int(float(v)) for v in c.split(","))
            tag = a.tag[k] if k < len(a.tag) else f"crop{k}"
            cp = os.path.join(a.out, f"{a.prefix}{t:.3f}_{tag}.png"); Image.open(p).crop((x, y, x + w, y + h)).save(cp); print(cp)
    if a.sheet:
        ims = [Image.open(p) for p in outs]; w = 480; h = int(ims[0].height * w / ims[0].width); cols = min(a.cols, len(ims))
        sheet = Image.new("RGB", (cols * w, ((len(ims) + cols - 1) // cols) * h), "black")
        for i, im in enumerate(ims): sheet.paste(im.convert("RGB").resize((w, h)), ((i % cols) * w, (i // cols) * h))
        sp = os.path.join(a.out, a.sheet); sheet.save(sp, quality=88); print(sp)
    print(f"# {len(times)} frames in {time.time() - t0:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
