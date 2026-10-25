#!/usr/bin/env bash
# Starts every Veil service locally (expects Postgres + Redis running and .env populated).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
set -a; . ./.env; set +a
mkdir -p .logs
start() { # name dir cmd...
  local name=$1 dir=$2; shift 2
  (cd "$ROOT/$dir" && exec nohup "$@" > "$ROOT/.logs/$name.log" 2>&1) &
  echo $! > "$ROOT/.logs/$name.pid"
  echo "started $name"
}
start chat-ws mini-services/chat-ws npx tsx src/index.ts
start media-worker mini-services/media-worker npx tsx src/index.ts
start link-scraper mini-services/link-scraper npx tsx src/index.ts
start call-signaling mini-services/call-signaling npx tsx src/index.ts
start push-service mini-services/push-service npx tsx src/index.ts
start web apps/web npx next dev --port 3000
