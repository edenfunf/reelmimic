#!/usr/bin/env python3
"""Fast, shared frame grabber for HyperFrames projects (used by builders and reviewers).

Why: every `hyperframes snapshot` call bundles the project, launches Chrome and settles the page (~10 s alone, minutes when
several agents do it at once, and page-load timeouts under load). Agents used to call it once per crop, per shot, per retry.
This tool makes that cheap:
  * ONE snapshot call per request, however many times you ask for (all shots, all moments together);
  * crops are cut from the full-resolution frame with PIL — never a separate --zoom render;
  * frames are cached by the content of the build folder: asking again for an unchanged moment costs nothing;
  * at most N snapshot processes run machine-wide (lock files), so parallel agents queue instead of timing out;
  * frames are taken from a silent mirror of the build (<audio> removed): headless Chrome held the page's DOMContentLoaded
    until the music had streamed, ~14 of the ~20 s a one-frame call cost; frames are pixel-identical without it;
  * automatic retry on the flaky "navigation timeout".

Usage (from anywhere):
  python hf_frames.py <build_dir> --at 12.4,13.0,15.25 --out <dir>                  → <dir>/t12.400.png …
  python hf_frames.py <build_dir> --at 12.4 --crop 1100,300,600,500 --tag face --out <dir>   → also t12.400_face.png
  python hf_frames.py <build_dir> --range 12.0:14.0:0.1 --out <dir> --sheet strip.jpg       → every 0.1 s + a contact sheet
  python hf_frames.py <build_dir> --range 12.0:12.5:f --out <dir>                             → every frame of the film
Prints one output path per line. Times are global (composition) seconds.

Every time is snapped to the frame the film shows at that moment (frame floor(t·fps), fps from plan.json /
production.json; --exact turns it off). A real run lost a review round to this: a builder checked a pose change at
times a few ms off the 30 fps grid, saw the in-between it had designed, and the film -- which only has the grid frames
-- jumped in one frame. Files keep the requested time in their name.
"""
import argparse, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

MAX_PARALLEL = int(os.environ.get("HF_SNAPSHOT_SLOTS", "3"))
PER_PROCESS = 12   # below this many frames a second Chrome costs more than it saves
LOCK_DIR = os.path.join(tempfile.gettempdir(), "hf_snapshot_slots")
CACHE = os.path.join(tempfile.gettempdir(), "hf_frame_cache")


def build_hash(build):
    h = hashlib.sha1()
    for root, dirs, files in os.walk(build):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in sorted(files):
            if f.endswith((".html", ".js", ".css", ".json", ".svg", ".png", ".jpg", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".m4a", ".wav")):
                p = os.path.join(root, f); st = os.stat(p)
                h.update(f"{os.path.relpath(p, build)}|{st.st_size}|{int(st.st_mtime_ns)}".encode())
    return h.hexdigest()[:16]


STATS = {"wait_s": 0.0, "render_s": 0.0, "rendered": 0}


class Slot:
    def __enter__(self):
        os.makedirs(LOCK_DIR, exist_ok=True)
        self.t0 = time.time()
        while True:
            for i in range(MAX_PARALLEL):
                p = os.path.join(LOCK_DIR, f"slot{i}")
                try:
                    if os.path.exists(p) and time.time() - os.path.getmtime(p) > 900: os.remove(p)   # stale
                    self.fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY); self.p = p
                    STATS["wait_s"] += time.time() - self.t0; self.t1 = time.time(); return self
                except FileExistsError:
                    continue
            time.sleep(1.5)

    def __exit__(self, *a):
        STATS["render_s"] += time.time() - self.t1
        os.close(self.fd); os.remove(self.p)


AUDIO = re.compile(r"<audio\b[^>]*>(?:\s*</audio>)?", re.I)
SKIP = ("node_modules", "renders", "snapshots", ".git", "out")


def silent_mirror(build, key):
    """A copy of the build without <audio> elements, made once per build content (files hard-linked when possible)."""
    dst = os.path.join(CACHE, "mirror2", key)
    if os.path.isfile(os.path.join(dst, ".ok")): return dst
    tmp = dst + f".{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    for root, dirs, files in os.walk(build):
        dirs[:] = [d for d in dirs if d not in SKIP]
        rel = os.path.relpath(root, build); os.makedirs(os.path.join(tmp, rel), exist_ok=True)
        for f in files:
            src, out = os.path.join(root, f), os.path.join(tmp, rel, f)
            if f.endswith(".html"):
                s = Path(src).read_text(encoding="utf-8", errors="surrogateescape")
                Path(out).write_text(AUDIO.sub("", s), encoding="utf-8", errors="surrogateescape")
            else:
                try: os.link(src, out)
                except OSError: shutil.copy2(src, out)
    open(os.path.join(tmp, ".ok"), "w").close()
    try: os.replace(tmp, dst)
    except OSError: shutil.rmtree(tmp, ignore_errors=True)   # another process made it first
    return dst


def snapshot(build, times, outdir):
    os.environ.setdefault("PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS", "60000")   # 10 s default fails under load with many agents
    cmd = ["npx", "hyperframes@0.8.80", "snapshot", ".", "--at", ",".join(f"{t:.6f}" for t in times), "--no-end",
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


def film_fps(build):
    for f in (os.path.join(os.path.dirname(build), "plan.json"), os.path.join(build, "production.json")):
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8-sig")); v = (d.get("format") or {}).get("fps") or d.get("fps")
            if v: return float(v)
        except (OSError, ValueError, AttributeError): pass
    return None


def frame_time(t, fps):
    """Start of the frame shown at time t (+10 µs so the seek never lands just before it). Times are written with 3
    decimals (19.733 for frame 592 = 19.7333 s at 30 fps), so up to 1.5 ms before a frame counts as that frame."""
    return round(int(t * fps + 0.0015 * fps) / fps + 1e-5, 6)


CACHE_MAX_GB = float(os.environ.get("HF_CACHE_GB", "4"))


def prune_cache(keep):
    """Every build edit makes a new cache folder; without a cap it filled the system drive (24 GB in one day, and a
    project's job.json was truncated when the disk ran out). Oldest folders go first; the current one stays."""
    try:
        dirs = [os.path.join(r, d) for r in (CACHE, os.path.join(CACHE, "mirror2")) if os.path.isdir(r) for d in os.listdir(r) if d != "mirror2"]
        dirs = [d for d in dirs if os.path.isdir(d) and os.path.basename(d) != keep]
        size = lambda d: sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)
        sizes = {d: size(d) for d in dirs}
        total = sum(sizes.values())
        for d in sorted(dirs, key=os.path.getmtime):
            if total <= CACHE_MAX_GB * 1e9: break
            shutil.rmtree(d, ignore_errors=True); total -= sizes[d]
    except OSError:
        pass


def grab(build, times):
    """Full-resolution PNG path for every time, rendering only the ones not cached for this exact build content."""
    key = build_hash(build)
    prune_cache(key); cdir = os.path.join(CACHE, key); os.makedirs(cdir, exist_ok=True)
    want = {t: os.path.join(cdir, f"t{t:.6f}.png") for t in times}
    todo = sorted({t for t, p in want.items() if not os.path.exists(p)})
    src = build
    if todo:
        try: src = silent_mirror(build, key)
        except OSError: src = build
    # Big requests are split over several Chrome processes (each takes its own slot): a frame costs ~1 s of seek and
    # screenshot, 36 frames took 36 s in one process and 17.5 s in three. Frames differ by at most 2/255 (GPU rounding).
    parts = max(1, min(MAX_PARALLEL, len(todo) // PER_PROCESS, 60), -(-len(todo) // 60))
    size = -(-len(todo) // parts) if todo else 0
    chunks = [todo[i:i + size] for i in range(0, len(todo), size)] if todo else []

    def run(chunk):
        tmp = tempfile.mkdtemp(prefix="hf_snap_")
        try:
            for t, fr in zip(chunk, snapshot(src, chunk, tmp)): shutil.move(fr, want[t])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        STATS["rendered"] += len(chunk)

    if len(chunks) > 1:
        with ThreadPoolExecutor(len(chunks)) as ex:
            for f in [ex.submit(run, c) for c in chunks]: f.result()
    elif chunks:
        run(chunks[0])
    return [want[t] for t in times]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("build"); ap.add_argument("--at"); ap.add_argument("--range", help="start:end:step (global seconds)")
    ap.add_argument("--crop", action="append", default=[], help="x,y,w,h (repeatable; applied to every time)")
    ap.add_argument("--tag", action="append", default=[]); ap.add_argument("--out", required=True)
    ap.add_argument("--sheet", help="also write a contact sheet with this file name"); ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--prefix", default="t"); ap.add_argument("--exact", action="store_true", help="seek the exact times, not the film's frames")
    a = ap.parse_args()
    build = os.path.abspath(a.build)
    fps = None if a.exact else film_fps(build)
    times = [float(x) for x in a.at.split(",")] if a.at else []
    if a.range:
        s, e, st = a.range.split(":"); s, e = float(s), float(e)
        if st == "f":
            if not fps: sys.exit("--range a:b:f needs the film's fps (plan.json or production.json)")
            times += [round(i / fps, 3) for i in range(int(s * fps + 1e-6), int(e * fps + 1e-6) + 1)]
        else:
            n = int(round((e - s) / float(st))) + 1
            times += [round(s + i * float(st), 3) for i in range(n)]
    if not times: sys.exit("give --at or --range")
    os.makedirs(a.out, exist_ok=True)
    seek = [frame_time(t, fps) for t in times] if fps else times
    if fps and len(set(seek)) < len(seek):
        print(f"# {len(seek) - len(set(seek))} of the requested times fall on a frame already asked for (the film has {fps:g} frames/s)", file=sys.stderr)
    t0 = time.time(); paths = grab(build, seek); outs = []
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
    log_call(build, len(times), time.time() - t0)


def log_call(build, n, total):
    """One line per call in <project>/logs/hf_frames.jsonl: where the time of a frame request goes (queue vs Chrome)."""
    logs = os.path.join(os.path.dirname(build), "logs")
    if not os.path.isdir(logs): return
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "frames": n, "rendered": STATS["rendered"], "total_s": round(total, 1),
           "wait_s": round(STATS["wait_s"], 1), "render_s": round(STATS["render_s"], 1), "slots": MAX_PARALLEL}
    try:
        with open(os.path.join(logs, "hf_frames.jsonl"), "a", encoding="utf-8") as f: f.write(json.dumps(rec) + "\n")
    except OSError: pass


if __name__ == "__main__":
    main()
