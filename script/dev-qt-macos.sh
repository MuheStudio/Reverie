#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/macos-common.sh"
if [[ "${1:-}" != "--disposable" ]]; then
  echo 'Usage: ./script/dev-qt-macos.sh --disposable [--build-dir ABS_BUILD_DIRECTORY]' >&2
  echo 'Starts an isolated local demonstration. Its data is removed on exit.' >&2
  exit 2
fi
shift
exec "$REVERIE_NODE" "$REVERIE_ROOT/native-ui/check-native.cjs" --interactive "$@"
