#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/macos-common.sh"
exec "$REVERIE_NODE" "$REVERIE_ROOT/native-ui/check-native.cjs" "$@"
