#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# These affect this launcher process only, never the user's shell configuration.
# Read-only export: diagnostics --output ABS [--runtime-root ABS] [--workspace ABS].
unset NODE_OPTIONS NODE_PATH PYTHONHOME PYTHONPATH VIRTUAL_ENV ELECTRON_RUN_AS_NODE
exec "$PROJECT_ROOT/.tools/node/bin/node" "$PROJECT_ROOT/native-ui/preview-runtime.cjs" "$@"
