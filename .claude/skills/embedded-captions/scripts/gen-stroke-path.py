#!/usr/bin/env python3
"""gen-stroke-path.py — generalized draw-on path generator.

Lays out ANY word in a single-line (pen-path) SVG font — Hershey/EMS — and emits
one continuous-dash-revealable path `d`. The glyph data IS the pen path, so
stroke-order reveal is exact by construction for any text, no per-word tuning.

Usage: gen-stroke-path.py <font.svg> <text> <target_width_px> <baseline_y> <x0>
Prints: the path `d` string + layout info on stderr.
"""
import html, re, sys

# Windows sizes stdio to the ANSI code page (cp1252). These scripts emit UTF-8 on
# every platform; say so rather than depending on the console's code page. Carry
# `errors` across: reconfigure() resets it to "strict", and CPython deliberately gives
# stderr "backslashreplace" so the diagnostic path can never itself raise.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors=_stream.errors)

font_path, text, target_w, baseline_y, x0 = (
    sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]))

# SVG fonts are UTF-8. Decoded with the platform default, a non-ASCII glyph key silently
# becomes the wrong character (or raises) on Windows, so that glyph never matches the
# requested text. A glyph's `unicode="…"` is a literal character or an XML character
# reference (`&amp;`, `&apos;`, `&#xe9;` …: 98 of the 188 glyphs in the bundled Hershey
# fonts), so unescape it before keying on it.
svg = open(font_path, encoding="utf-8").read()
glyphs = {}
for m in re.finditer(r'<glyph\s+unicode="([^"]+)"[^>]*?horiz-adv-x="([\d.]+)"(?:[^>]*?d="([^"]*)")?', svg):
    ch, adv, d = html.unescape(m.group(1)), float(m.group(2)), m.group(3) or ""
    # layout below is one glyph per character, so skip ligatures. On a duplicate code
    # point the first glyph wins, as in SVG font matching (HersheyScript1 has a second £).
    if len(ch) == 1:
        glyphs.setdefault(ch, (adv, d))
# default advance for space
space_adv = glyphs.get(" ", (300, ""))[0]

# total advance width in font units
total = 0.0
for ch in text:
    total += glyphs.get(ch, (space_adv, ""))[0]
s = target_w / total                       # scale font-units → px

# Most glyphs are `M x y L x y …` polylines, but a few added later (ß, Ç, ç, ¸, the
# second £) use compact syntax (`M190.0 205.0L494.0 …`) with cubic curves and Z.
# Absolute M/L/C/Z cover every glyph in the bundled fonts; curves are flattened so
# the output stays M/L only.
PATH_TOK = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
CURVE_STEP = 30.0                            # font units per flattened segment

def pen_path(d):
    toks, i, cmd = PATH_TOK.findall(d), 0, None
    cx = cy = sx = sy = 0.0
    def nums(n):
        nonlocal i
        vals = [float(t) for t in toks[i:i + n]]
        i += n
        return vals
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd == "Z":
                if (cx, cy) != (sx, sy):
                    yield "L", sx, sy
                cx, cy = sx, sy
            continue
        if cmd == "M":
            cx, cy = sx, sy = nums(2)
            yield "M", cx, cy
            cmd = "L"                        # extra pairs after M are linetos
        elif cmd == "L":
            cx, cy = nums(2)
            yield "L", cx, cy
        elif cmd == "C":
            x1, y1, x2, y2, x3, y3 = nums(6)
            span = (abs(x1 - cx) + abs(y1 - cy) + abs(x2 - x1) + abs(y2 - y1)
                    + abs(x3 - x2) + abs(y3 - y2))
            n = max(2, round(span / CURVE_STEP))
            for k in range(1, n + 1):
                t = k / n
                u = 1 - t
                yield ("L",
                       u**3 * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3,
                       u**3 * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3)
            cx, cy = x3, y3
        else:
            raise SystemExit(f"[gen] unsupported path command {cmd!r} in {font_path}")

out = []
cursor = 0.0
NUM = re.compile(r"[-\d.]+")
for ch in text:
    adv, d = glyphs.get(ch, (space_adv, ""))
    if d:
        for cmd, xs, ys in pen_path(d):
            x = x0 + (cursor + xs) * s
            y = baseline_y - ys * s                 # SVG-font y is UP; flip
            out.append(f"{cmd} {x:.1f} {y:.1f}")
    cursor += adv

print(" ".join(out))
print(f"[gen] chars={len(text)} scale={s:.3f} width={total*s:.0f}px "
      f"subpaths={sum(1 for o in out if o.startswith('M'))}", file=sys.stderr)
