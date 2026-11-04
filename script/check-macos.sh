#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=macos-common.sh
source "$SCRIPT_DIR/macos-common.sh"

if [[ ! -x "$REVERIE_NODE" ]]; then
  echo "Project Node is missing. Run: bash script/setup-macos.sh" >&2
  exit 1
fi

exec "$REVERIE_NODE" "$SCRIPT_DIR/check-macos.cjs" "$@"
