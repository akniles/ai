#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
docker run --rm -v "$root/.local/https/letsencrypt:/etc/letsencrypt" -v "$root/.local/https/acme:/var/www/acme" certbot/certbot:v5.10.0 renew --non-interactive
sh scripts/compose.sh exec -T edge nginx -t
sh scripts/compose.sh exec -T edge nginx -s reload
