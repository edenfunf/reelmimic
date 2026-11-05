#!/usr/bin/env python3
"""Yating (雅婷, Taiwan) text-to-speech — natural Taiwan Mandarin voices.

Key: env YATING_KEY, or ~/.reelmimic/secrets.json {"YATING_KEY": "..."} (never stored in a project).

  python yating_tts.py "這是我家的橘貓，橘寶。" --out l1.wav [--voice zh_en_female_1] [--speed 1.0] [--pitch 1.0] [--energy 1.0]
  python yating_tts.py --lines lines.json --outdir vo/ [--voice ...]      # [{"id":"L1","text":"...","speed":0.95,...}, ...] → vo/L1.wav
  python yating_tts.py --list

Voices (v2): zh_en_female_1 雅婷 · zh_en_female_2 意晴 · zh_en_male_1 家豪 · zh_en_male_2 志明 (華語+英語, 22K)
             tai_female_1 · tai_female_2 · tai_male_1 (台語, 16K)
speed: SMALLER = faster (0.5–1.5); pitch/energy 0.5–1.5. Plain text ≤ 600 chars (a CJK char counts 2). Max 3 requests at once per key.
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

URL = "https://tts.api.yating.tw/v2/speeches/short"
VOICES = {"zh_en_female_1": "雅婷（女）", "zh_en_female_2": "意晴（女）", "zh_en_male_1": "家豪（男）", "zh_en_male_2": "志明（男）",
          "tai_female_1": "雅婷（台語女）", "tai_female_2": "意晴（台語女）", "tai_male_1": "家豪（台語男）"}


def key():
    k = os.environ.get("YATING_KEY")
    if not k:
        for p in ("~/.reelmimic/secrets.json", "~/.clone-studio/secrets.json"):   # second: pre-rename location
            p = os.path.expanduser(p)
            if os.path.exists(p): k = json.loads(Path(p).read_text(encoding="utf-8")).get("YATING_KEY"); break
    if not k: sys.exit("no YATING_KEY (env or ~/.reelmimic/secrets.json)")
    return k


def synth(text, out, voice="zh_en_female_1", speed=1.0, pitch=1.0, energy=1.0, ssml=False):
    rate = "16K" if voice.startswith("tai_") else "22K"
    body = {"input": {"text": text, "type": "ssml" if ssml else "text"},
            "voice": {"model": voice, "speed": speed, "pitch": pitch, "energy": energy},
            "audioConfig": {"encoding": "LINEAR16", "sampleRate": rate}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"key": key(), "Content-Type": "application/json"}, method="POST")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=150) as r: d = json.load(r)
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            Path(out).write_bytes(base64.b64decode(d["audioContent"]))
            return out
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:400]
            if e.code in (429, 500, 503) or "busy" in msg: time.sleep(2 + 3 * attempt); continue
            sys.exit(f"yating {e.code}: {msg}")
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 + 3 * attempt)
    sys.exit("yating: failed after retries")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?"); ap.add_argument("--out"); ap.add_argument("--lines"); ap.add_argument("--outdir")
    ap.add_argument("--voice", default="zh_en_female_1"); ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--pitch", type=float, default=1.0); ap.add_argument("--energy", type=float, default=1.0)
    ap.add_argument("--ssml", action="store_true"); ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list:
        for k, v in VOICES.items(): print(k, v)
        return
    if a.lines:
        L = json.loads(Path(a.lines).read_text(encoding="utf-8"))
        def one(x):
            return synth(x["text"], os.path.join(a.outdir, f"{x['id']}.wav"), x.get("voice", a.voice), x.get("speed", a.speed), x.get("pitch", a.pitch), x.get("energy", a.energy), x.get("ssml", a.ssml))
        with ThreadPoolExecutor(3) as ex:   # the API allows 3 concurrent requests per key
            for p in ex.map(one, L): print(p)
        return
    if not (a.text and a.out): sys.exit("give TEXT --out FILE, or --lines FILE --outdir DIR")
    print(synth(a.text, a.out, a.voice, a.speed, a.pitch, a.energy, a.ssml))


if __name__ == "__main__":
    main()
