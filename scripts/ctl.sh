#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec sh scripts/compose.sh exec -T control node src/cli.mjs "$@"
