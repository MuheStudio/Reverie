#!/bin/bash
# Source only: scoped tool paths; never changes a shell profile or global Python.
REVERIE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export REVERIE_ROOT
export REVERIE_NODE="$REVERIE_ROOT/.tools/node/bin/node"
export REVERIE_PYTHON="$REVERIE_ROOT/.venv/bin/python"
export REVERIE_UV="$REVERIE_ROOT/.tools/uv/uv"
export REVERIE_UV_VERSION="0.12.17"
export REVERIE_PNPM="$REVERIE_ROOT/.tools/pnpm/bin/pnpm.cjs"
export PATH="$REVERIE_ROOT/.tools/node/bin:$REVERIE_ROOT/.tools/bin:$PATH"
export UV_CACHE_DIR="$REVERIE_ROOT/.tools/cache/uv"
export UV_PYTHON_INSTALL_DIR="$REVERIE_ROOT/.tools/python"
export UV_PYTHON_INSTALL_BIN=0
export UV_PYTHON_CPYTHON_BUILD=20260901
export UV_NO_CONFIG=1
export UV_DEFAULT_INDEX="https://pypi.org/simple"
export PIP_CACHE_DIR="$REVERIE_ROOT/.tools/cache/pip"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CONFIG_FILE=/dev/null
export npm_config_cache="$REVERIE_ROOT/.tools/cache/npm"
export npm_config_store_dir="$REVERIE_ROOT/.tools/cache/pnpm-store"
export npm_config_cache_dir="$REVERIE_ROOT/.tools/cache/pnpm"
export npm_config_state_dir="$REVERIE_ROOT/.tools/cache/pnpm-state"
export PNPM_HOME="$REVERIE_ROOT/.tools/pnpm-home"
export XDG_CACHE_HOME="$REVERIE_ROOT/.tools/cache"
export XDG_DATA_HOME="$REVERIE_ROOT/.tools/data"
export XDG_STATE_HOME="$REVERIE_ROOT/.tools/state"
export ELECTRON_CACHE="$REVERIE_ROOT/.tools/cache/electron"
export electron_config_cache="$ELECTRON_CACHE"
export ELECTRON_INSTALL_PLATFORM=darwin
export ELECTRON_INSTALL_ARCH=arm64
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH="$REVERIE_ROOT/.tools/cache/playwright"
# These variables can select an unrelated interpreter or turn Electron into Node.
unset PYTHONHOME PYTHONPATH VIRTUAL_ENV ELECTRON_RUN_AS_NODE UV_INDEX UV_INDEX_URL UV_EXTRA_INDEX_URL UV_FIND_LINKS
unset ELECTRON_OVERRIDE_DIST_PATH electron_use_remote_checksums npm_config_electron_use_remote_checksums
