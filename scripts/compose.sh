#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec docker compose --project-directory . --env-file .env -p ai -f deploy/langfuse.upstream.yml -f compose.yml "$@"
