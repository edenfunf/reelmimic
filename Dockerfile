# ReelMimic in one container: Node, Python and its packages, FFmpeg, Chromium, CJK fonts, Claude Code and Codex.
#   docker compose up -d --build   →  http://localhost:4318      (see "Docker" in README.md)
FROM node:22-bookworm

# libgl1 + libglib2.0-0: opencv-python; fonts-noto-cjk: Chinese/Japanese text in rendered frames
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ffmpeg chromium fonts-noto-cjk fonts-noto-color-emoji libgl1 libglib2.0-0 git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv && pip install --no-cache-dir -r /tmp/requirements.txt

# the agents run in the repo (skills, AGENTS.md) and write into projects/, so the whole checkout belongs to the app user
RUN mkdir /reelmimic && chown node:node /reelmimic
USER node
WORKDIR /reelmimic
COPY --chown=node:node app/package.json app/package-lock.json app/
RUN cd app && npm ci && npm cache clean --force
COPY --chown=node:node . .
RUN cd app && npm run build

ENV HOST=0.0.0.0 PORT=4318 PYTHON=/opt/venv/bin/python CHROME_PATH=/usr/bin/chromium
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -sf http://localhost:4318/api/health || exit 1
WORKDIR /reelmimic/app
CMD ["node", "server/index.ts"]
