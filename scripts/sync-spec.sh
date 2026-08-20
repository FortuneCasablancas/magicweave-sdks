#!/usr/bin/env bash
# Pull the client OpenAPI snapshot from the backend into spec/.
#
#   ./scripts/sync-spec.sh                       # from a sibling backend checkout
#   ./scripts/sync-spec.sh --url https://api.magicweave.xyz/openapi.json
#   ./scripts/sync-spec.sh --check               # fail if spec/ is stale
#
# The backend owns the snapshot (backend/contracts/client-openapi.snapshot.json,
# written by backend/scripts/dump_client_openapi.py and gated in its CI). This
# repo holds a copy so codegen never depends on a live service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/spec/client-openapi.snapshot.json"
BACKEND_SNAPSHOT="${MW_BACKEND_DIR:-$ROOT/../backend}/contracts/client-openapi.snapshot.json"

CHECK=false
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=true; shift ;;
    --url)   URL="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [ -n "$URL" ]; then
  echo "fetching $URL"
  curl -fsSL "$URL" | python3 -m json.tool --sort-keys > "$tmp"
elif [ -f "$BACKEND_SNAPSHOT" ]; then
  echo "copying $BACKEND_SNAPSHOT"
  cp "$BACKEND_SNAPSHOT" "$tmp"
else
  echo "error: no backend checkout at $BACKEND_SNAPSHOT and no --url given" >&2
  exit 1
fi

if $CHECK; then
  if diff -q "$tmp" "$DEST" >/dev/null 2>&1; then
    echo "spec is current"
    exit 0
  fi
  echo "spec is stale — run ./scripts/sync-spec.sh and commit the result" >&2
  diff "$DEST" "$tmp" | head -40 >&2 || true
  exit 1
fi

cp "$tmp" "$DEST"
echo "wrote $DEST"
