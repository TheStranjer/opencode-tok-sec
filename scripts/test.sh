#!/usr/bin/env sh
# Test entry point.
#
# The MeterLine layout test drives the real @opentui/core native renderer via
# the core testing module, which needs `node:ffi` — Node >= 26.1 with
# `--experimental-ffi`. Older runtimes reject an unknown flag outright, so
# probe for support instead of hard-coding it; where the flag is absent the
# test creates no renderer and skips itself.
set -eu
cd "$(dirname "$0")/.."

FFI_FLAG=""
if node --experimental-ffi -e "" >/dev/null 2>&1; then
  FFI_FLAG="--experimental-ffi"
fi

exec node $FFI_FLAG --conditions=browser --import tsx --test test/*.test.ts
