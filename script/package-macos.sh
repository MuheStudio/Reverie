#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/macos-common.sh"
if [[ ! -x "$REVERIE_NODE" || ! -x "$REVERIE_UV" ]]; then
  echo 'The pinned project build tools are missing. This build does not recreate the development environment.' >&2
  exit 1
fi
exec "$REVERIE_NODE" "$REVERIE_ROOT/frontend/script/package-macos-test.cjs" "$@"
