#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/macos-common.sh"
exec "$REVERIE_NODE" "$REVERIE_ROOT/frontend/script/smoke-packaged-macos.cjs" "$@"
