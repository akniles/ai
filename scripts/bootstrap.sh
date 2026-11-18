#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -s .env || { echo 'Create .env from .env.example first.' >&2; exit 1; }
chmod 600 .env
sh scripts/compose.sh build control
# The control plane needs the stopped worker container to exist before reconciliation.
sh scripts/compose.sh create worker
sh scripts/compose.sh up -d control web hindsight langfuse-web langfuse-worker
echo 'Starts latched in panic on first installation. Resume explicitly after checking status.'
