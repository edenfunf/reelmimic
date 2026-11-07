#!/usr/bin/env python3
"""beat_grid.py <audio> [--from=S] [--to=S] [--lrc=file.lrc] — tempo, beat phase, and where each lyric line sits on the grid.

Needs ffmpeg and numpy (python3 -m venv .venv && .venv/bin/pip install numpy). Prints the BPM (the fast pulse; halve it
for a ballad feel in PROJECT.bpm), the time of a beat near --from, and for each LRC line its beat index, so you can
pick a clip start on a bar line and put PROJECT.offset on the grid.
"""
import re, subprocess, sys
import numpy as np

args = dict(a.lstrip('-').split('=', 1) if '=' in a else (a, True) for a in sys.argv[2:])
src, t0, t1 = sys.argv[1], float(args.get('from', 0)), float(args.get('to', 0)) or None
sr, hop, win = 22050, 128, 2048
cmd = ['ffmpeg', '-v', 'error', '-ss', str(t0)] + (['-t', str(t1 - t0)] if t1 else []) + ['-i', src, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-']
x = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32)

# spectral-flux onset envelope
fr = np.lib.stride_tricks.sliding_window_view(x, win)[::hop]
S = np.log1p(np.abs(np.fft.rfft(fr * np.hanning(win), axis=1)))
flux = np.maximum(0, np.diff(S, axis=0)).sum(1)
flux = np.maximum(flux - np.convolve(flux, np.ones(64) / 64, 'same'), 0)
fps = sr / hop

# tempo: autocorrelation peak (interpolated lag) between 70 and 170 BPM
ac = np.correlate(flux, flux, 'full')[len(flux) - 1:]
def score(bpm):
    lag = fps * 60 / bpm; l = int(lag); f = lag - l
    return ac[l] * (1 - f) + ac[l + 1] * f
bpm = max(np.arange(70, 170, .05), key=score)
B = 60 / bpm

# phase: the offset whose comb of beats collects the most onset energy
def comb(p):
    idx = (np.arange(p, len(flux) / fps, B) * fps).astype(int)
    return flux[idx[idx < len(flux)]].sum()
phase = max(np.arange(0, B, .005), key=comb)
first = t0 + phase
print(f'bpm {bpm:.2f}  (half-time {bpm / 2:.3f})   beat {B:.4f} s   a beat at {first:.3f} s')

if 'lrc' in args:
    # A line with several timestamps is sung that many times (a repeated chorus): list it once per time,
    # in time order, the same way align_lyrics.py reads LRC.
    rows, repeated = [], False
    for line in open(args['lrc'], encoding='utf-8'):
        line = line.strip(); m = re.match(r'(?:\[\d+:\d+(?:\.\d+)?\])+', line)
        if not m: continue
        stamps = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', m[0])
        repeated |= len(stamps) > 1
        rows += [(int(mm) * 60 + float(ss), line[m.end():]) for mm, ss in stamps]
    if repeated: rows.sort(key=lambda r: r[0])
    for t, text in rows:
        print(f'{t:8.2f}  beat {(t - first) / B:7.2f}  {text}')
