#!/bin/bash
set -euo pipefail

REVERIE_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=script/macos-common.sh
source "$REVERIE_SCRIPT_DIR/macos-common.sh"

exec "$REVERIE_NODE" "$REVERIE_ROOT/frontend/script/dev-macos.cjs"
