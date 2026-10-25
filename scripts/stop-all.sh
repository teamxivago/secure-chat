#!/usr/bin/env bash
# Stops all locally started Veil services (matches by repo path, then frees the ports).
cd "$(dirname "$0")/.."
ROOT=$(pwd)
rm -f .logs/*.pid
for pat in "$ROOT/mini-services/.*/tsx" "$ROOT/node_modules/.pnpm/tsx" "$ROOT/apps/web/node_modules/.bin/../next" "next-server" "npm exec tsx src/index.ts" "npm exec next dev" "sh -c tsx src/index.ts" "sh -c next dev"; do
  pkill -f "$pat" 2>/dev/null || true
done
echo stopped
