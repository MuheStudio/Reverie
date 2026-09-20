#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/macos-common.sh"
exec "$REVERIE_NODE" "$REVERIE_ROOT/script/lock-macos.cjs"
