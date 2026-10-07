#!/usr/bin/env bash
# ReelMimic — build the UI if needed and start the server on http://localhost:4318
set -e
cd "$(dirname "$0")/app"
[ -d node_modules ] || npm install
[ -d dist ] || npm run build
# open the browser once the server answers /api/health (a cold start can take a while); give up after a minute
( SECONDS=0; until curl -sf -m 2 http://localhost:4318/api/health >/dev/null 2>&1; do
    [ $SECONDS -lt 60 ] || { echo "ReelMimic is not answering on http://localhost:4318: see the messages above, or open it yourself once it is up." >&2; exit 1; }
    sleep 1; done
  (command -v xdg-open >/dev/null && xdg-open http://localhost:4318) || (command -v open >/dev/null && open http://localhost:4318) || true ) &
exec node server/index.ts
