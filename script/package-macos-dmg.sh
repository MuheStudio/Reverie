#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/macos-common.sh"
exec "$REVERIE_NODE" "$REVERIE_ROOT/frontend/script/package-macos-dmg.cjs" "$@"
