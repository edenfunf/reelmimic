#!/usr/bin/env python3
"""clip_strip.py — consecutive frames of a stretch of video as one image, optionally stacked against the reference.

Stills can't show motion or a climax: a hit is the frames around it. Use this whenever you judge a moment.

    python clip_strip.py out/video.mp4 --range 24.0:26.0 --out out/check/peak_1.jpg
    python clip_strip.py out/video.mp4 --range 24.0:26.0 --vs analysis/proxy.mp4 --vs-range 25.0:27.0 --out out/check/peak_1_vs_ref.jpg

The reference is the file analyze.py actually analysed (report.json "analysed": proxy.mp4 when the picture had to be
cropped out of a screen recording). Passing analysis/source.mp4 is switched to proxy.mp4 automatically when one exists,
and a reference row that comes out (almost) black stops with an error instead of producing a fake comparison.

--fps (default 12) frames per second of the stretch; --w (default 240) width of each frame; --cols (default 12).
With --vs, the reference range is sampled into the same number of frames and each reference row sits directly above
the matching row of ours (labelled REF / OURS with the time of every frame), so the build, the hit and the hold line up.
"""
import argparse, os, shutil, subprocess, sys, tempfile

FFMPEG_FALLBACK = os.environ.get("FFMPEG_DIR", "")
if not shutil.which("ffmpeg") and FFMPEG_FALLBACK and os.path.isdir(FFMPEG_FALLBACK):
    os.environ["PATH"] += os.pathsep + FFMPEG_FALLBACK

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for f in ("arial.ttf", "DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()


def grab(path, a, b, n, w):
    """n frames evenly spread over [a, b), each w px wide."""
    tmp = tempfile.mkdtemp(prefix="strip_")
    fps = n / max(b - a, 1e-3)
    subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{a}", "-t", f"{b - a}", "-i", path,
                    "-vf", f"fps={fps},scale={w}:-2", "-frames:v", str(n), os.path.join(tmp, "f%04d.png")], check=True)
    files = sorted(os.listdir(tmp))
    ims = [Image.open(os.path.join(tmp, f)).convert("RGB") for f in files]
    shutil.rmtree(tmp, ignore_errors=True)
    return [(a + i / fps, im) for i, im in enumerate(ims)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("--range", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--vs"); ap.add_argument("--vs-range")
    ap.add_argument("--fps", type=float, default=12); ap.add_argument("--w", type=int, default=240); ap.add_argument("--cols", type=int, default=12)
    a = ap.parse_args()
    s, e = map(float, a.range.split(":"))
    n = max(2, round((e - s) * a.fps))
    ours = grab(a.video, s, e, n, a.w)
    if not ours: raise SystemExit(f"no frames in {a.video} between {s}s and {e}s: is --range past the end of the video?")
    ref = None
    if a.vs:
        vs = a.vs
        proxy = os.path.join(os.path.dirname(vs), "proxy.mp4")
        if os.path.basename(vs).startswith("source.") and os.path.isfile(proxy):
            print(f"reference: using {proxy} (the cropped picture) instead of {vs}"); vs = proxy
        rs, re_ = map(float, (a.vs_range or a.range).split(":"))
        ref = grab(vs, rs, re_, len(ours), a.w)
        if not ref: raise SystemExit(f"no frames in {vs} between {rs}s and {re_}s: is --vs-range past the end of the reference?")
        dark = sum(1 for _, im in ref if max(im.convert("L").getextrema()) < 30) / max(1, len(ref))
        if dark > 0.8:
            raise SystemExit(f"reference rows are black ({dark:.0%} of frames) — wrong file or time range? Use the file in report.json 'analysed' (usually analysis/proxy.mp4)")
    fh = ours[0][1].height; lab = 18; f = font(13)
    rows = [ours[i:i + a.cols] for i in range(0, len(ours), a.cols)]
    refrows = [ref[i:i + a.cols] for i in range(0, len(ref), a.cols)] if ref else []
    bands = []
    for k, row in enumerate(rows):
        if ref: bands.append(("REF", refrows[k] if k < len(refrows) else []))
        bands.append(("OURS" if ref else "", row))
    W = a.cols * a.w + 50; H = len(bands) * (fh + lab) + (len(rows) * 8 if ref else 0)
    sheet = Image.new("RGB", (W, H), (24, 24, 28)); d = ImageDraw.Draw(sheet)
    y = 0
    for i, (name, row) in enumerate(bands):
        d.text((4, y + lab + fh // 2 - 7), name, fill=(255, 200, 80) if name == "REF" else (120, 220, 255), font=f)
        for j, (t, im) in enumerate(row):
            x = 50 + j * a.w
            sheet.paste(im, (x, y + lab)); d.text((x + 3, y + 2), f"{t:.2f}s", fill=(220, 220, 220), font=f)
        y += fh + lab
        if ref and name == "OURS": y += 8
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sheet.save(a.out, quality=90)
    print(f"wrote {a.out}  ({len(ours)} frames{' vs reference' if ref else ''})")


if __name__ == "__main__":
    main()
