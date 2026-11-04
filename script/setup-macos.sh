#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/macos-common.sh"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Reverie setup requires native macOS arm64 (not Rosetta)." >&2
  exit 1
fi
manifest="$REVERIE_ROOT/config/macos-toolchain.json"
mkdir -p "$REVERIE_ROOT/.tools/cache/downloads" "$REVERIE_ROOT/.tools/tmp"
if [[ ! -e "$REVERIE_ROOT/.tools/node" ]]; then
  url="$(/usr/bin/plutil -extract node.url raw -o - "$manifest")"
  expected="$(/usr/bin/plutil -extract node.sha256 raw -o - "$manifest")"
  archive="$REVERIE_ROOT/.tools/cache/downloads/node.tar.gz"
  if [[ ! -f "$archive" ]]; then
    /usr/bin/curl --silent --show-error --fail --location --retry 3 --connect-timeout 20 "$url" -o "$archive.part"
    actual="$(/usr/bin/shasum -a 256 "$archive.part" | /usr/bin/awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || { echo 'Node download checksum mismatch.' >&2; exit 1; }
    mv "$archive.part" "$archive"
  fi
  actual="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo 'Cached Node checksum mismatch; inspect the archive before retrying.' >&2; exit 1; }
  staging="$(mktemp -d "$REVERIE_ROOT/.tools/tmp/node.XXXXXX")"
  /usr/bin/tar -xzf "$archive" --strip-components=1 -C "$staging"
  mv "$staging" "$REVERIE_ROOT/.tools/node"
fi
[[ -x "$REVERIE_NODE" ]] || { echo 'Existing project Node is incomplete; it was not replaced.' >&2; exit 1; }
expected_version="$(/usr/bin/plutil -extract node.version raw -o - "$manifest")"
[[ "$("$REVERIE_NODE" --version)" == "v$expected_version" ]] || { echo 'Existing project Node version differs from the manifest.' >&2; exit 1; }
exec "$REVERIE_NODE" "$REVERIE_ROOT/script/setup-macos.cjs" "$@"
