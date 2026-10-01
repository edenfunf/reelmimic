#!/usr/bin/env python3
"""align_lyrics.py — time the lyrics the USER provides against the USER's audio, and write a karaoke LRC.

    python align_lyrics.py <audio> <lyrics.txt> --out subs.lrc [--start 100.8 --end 131.7] [--model medium]

The lyric TEXT always comes from the user (pasted in the app → inputs/lyrics.txt); this script only finds WHEN each line is
sung. It never writes words of its own: speech recognition is used as a timing ruler, and every output line is the user's line.

How: faster-whisper transcribes the audio with per-word timestamps → both texts are normalised (punctuation/space removed,
simplified→traditional when OpenCC is available) → the user's characters are aligned to the recognised characters
(difflib matching blocks, in order) → each line gets the time of its first and last matched character; lines with no match
are interpolated between their neighbours. Writes:
    subs.lrc        [mm:ss.xx] line   (times relative to --start, i.e. clip time)
    subs.json       per line: start, end, text, matched ratio, per-character times (for karaoke fill)
and prints a quality report: lines matched, mean match ratio. Low ratios mean "check by ear" (the app shows them).
"""
import argparse, difflib, json, os, re, shutil, subprocess, sys, tempfile

FFMPEG_FALLBACK = os.environ.get("FFMPEG_DIR", "")   # folder with ffmpeg/ffprobe when they are not on PATH
if not shutil.which("ffmpeg") and FFMPEG_FALLBACK and os.path.isdir(FFMPEG_FALLBACK): os.environ["PATH"] += os.pathsep + FFMPEG_FALLBACK

try:
    from opencc import OpenCC
    _s2t = OpenCC("s2t").convert
except Exception:
    _s2t = lambda s: s

KEEP = re.compile(r"[\w\u3400-\u9fff]", re.UNICODE)
def norm_chars(s):
    return [c.lower() for c in _s2t(s) if KEEP.match(c)]


def transcribe(wav, model_name, lang):
    from faster_whisper import WhisperModel
    try:
        m = WhisperModel(model_name, device="cuda", compute_type="float16")
    except Exception:
        m = WhisperModel(model_name, device="cpu", compute_type="int8")
    segs, _ = m.transcribe(wav, language=lang, word_timestamps=True, vad_filter=True, vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 60}, beam_size=5,
                           condition_on_previous_text=False)
    chars = []   # (char, t_start, t_end): a word's time is spread evenly over its characters
    for sg in segs:
        for w in (sg.words or []):
            cs = norm_chars(w.word)
            if not cs: continue
            d = (w.end - w.start) / len(cs)
            for k, c in enumerate(cs): chars.append((c, w.start + k * d, w.start + (k + 1) * d))
    return chars


def fmt(t):
    cs = round(max(0.0, t) * 100); return f"[{cs // 6000:02d}:{cs % 6000 / 100:05.2f}]"   # round first: 59.996 → [01:00.00]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("audio"); ap.add_argument("lyrics"); ap.add_argument("--out", required=True)
    ap.add_argument("--start", type=float, default=0.0); ap.add_argument("--end", type=float)
    ap.add_argument("--model", default="medium"); ap.add_argument("--lang", default="zh")
    a = ap.parse_args()
    lines = [l.strip() for l in open(a.lyrics, encoding="utf-8").read().splitlines() if l.strip() and not l.strip().startswith("[")]
    if not lines: sys.exit("no lyric lines in " + a.lyrics)
    tmp = os.path.join(tempfile.mkdtemp(), "clip.wav")
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(a.start)]
    if a.end: cmd += ["-t", str(a.end - a.start)]
    subprocess.run(cmd + ["-i", a.audio, "-vn", "-ac", "1", "-ar", "16000", tmp], check=True)
    rec = transcribe(tmp, a.model, a.lang)
    rec_s = [c for c, _, _ in rec]
    # the user's characters, remembering which line each belongs to
    user, owner = [], []
    for i, l in enumerate(lines):
        cs = norm_chars(l); user += cs; owner += [i] * len(cs)
    times = [None] * len(user)
    sm = difflib.SequenceMatcher(a=user, b=rec_s, autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size): times[blk.a + k] = (rec[blk.b + k][1], rec[blk.b + k][2])
    out = []
    for i, l in enumerate(lines):
        idx = [k for k, o in enumerate(owner) if o == i]
        got = [times[k] for k in idx if times[k]]
        ratio = len(got) / max(1, len(idx))
        out.append({"text": l, "start": got[0][0] if got else None, "end": got[-1][1] if got else None, "match": round(ratio, 2),
                    "chars": [times[k] for k in idx]})
    # lines that found nothing: each run of them shares the gap between its matched neighbours evenly, in order
    k = 0
    while k < len(out):
        if out[k]["start"] is not None: k += 1; continue
        j = k
        while j < len(out) and out[j]["start"] is None: j += 1   # out[k:j] found nothing
        s0 = out[k - 1]["end"] if k else 0.0
        s1 = out[j]["start"] if j < len(out) else (rec[-1][2] if rec else s0)
        step = (s1 - s0) / (j - k) if s1 > s0 else 2.0
        for n in range(j - k): out[k + n].update(start=s0 + n * step, end=s0 + (n + 1) * step, interpolated=True)
        k = j
    # keep order monotonic, and no line ending before it starts
    for k in range(1, len(out)):
        if out[k]["start"] < out[k - 1]["start"]: out[k]["start"] = out[k - 1]["end"]
    for o in out: o["end"] = max(o["end"], o["start"])
    with open(a.out, "w", encoding="utf-8") as f:
        for o in out: f.write(f"{fmt(o['start'])}{o['text']}\n")
    json.dump({"clip_start": a.start, "lines": out}, open(os.path.splitext(a.out)[0] + ".json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ok = [o for o in out if not o.get("interpolated")]
    print(f"lines {len(out)}, matched {len(ok)}, mean match {sum(o['match'] for o in out) / len(out):.2f}")
    for o in out: print(f"  {fmt(o['start'])}–{fmt(o['end'])} match {o['match']:.2f}{' (interpolated)' if o.get('interpolated') else ''}  {o['text']}")


if __name__ == "__main__":
    main()
