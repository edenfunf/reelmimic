# Troubleshooting

Start with the doctor:

```bash
cd app && npm run doctor
```

It checks Node, Python, FFmpeg, Chrome and the agent CLIs, and tells you what
is missing. The fixes below are the ones it catches most often.

## The wrong Python is picked

Symptom: analysis fails with a Python error, or the doctor says Python 3.10+
was not found.
Fix: point ReelMimic at a real one and restart:

```bash
PYTHON=/usr/bin/python3.12 ./start.sh
```

On Windows set `PYTHON` to the full path before starting, or add
`"PYTHON": "C:\\Python312\\python.exe"` to `~/.reelmimic/secrets.json`.

## Chrome is missing

Symptom: a render stops right at the browser step.
Fix: install Chrome (or Chromium) and tell ReelMimic where it lives:

```bash
CHROME_PATH=/usr/bin/chromium ./start.sh
```

## The Codex sandbox blocks the renderer

Symptom: with Codex, the Chrome renderer never starts.
Fix: Codex defaults to `danger-full-access`. If you switched it to
`workspace-write`, the renderer is blocked — keep the default, or set
`"CODEX_SANDBOX": "danger-full-access"` in the secrets file.

## The port is taken

Symptom: a second instance dies with `EADDRINUSE` instead of opening.
Fix: an instance may already be running at <http://localhost:4318>. Stop it,
or run this one on another port:

```bash
PORT=5000 ./start.sh
```

## Where did my videos go

Symptom: you cannot find a finished film.
Fix: everything lives under `projects/<id>/` — the final video is
`projects/<id>/out/video.mp4`, next to the reference, frames and notes.
Nothing is uploaded anywhere; if a folder is gone, it was deleted locally.
