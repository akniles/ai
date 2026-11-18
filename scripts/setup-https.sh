#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ip=${1:?Pass the public IPv4 address}
case "$ip" in *[!0-9.]*|'') echo 'Expected an IPv4 address' >&2; exit 1;; esac
root=$(pwd)
mkdir -p .local/https/acme .local/https/letsencrypt
cat > .local/https/nginx.conf <<'NGINX'
server {
  listen 80;
  server_name _;
  resolver 127.0.0.11 valid=10s;
  location /.well-known/acme-challenge/ { root /var/www/acme; }
  location / { set $upstream http://web:8080; proxy_pass $upstream; }
}
NGINX
# Preserve every existing secret and change only these deployment settings.
python3 - "$ip" <<'PY'
import pathlib,sys
p=pathlib.Path('.env'); settings={'PUBLIC_BIND':'127.0.0.1:8080','COMPOSE_PROFILES':'https','NEXTAUTH_URL':f'https://{sys.argv[1]}:8443'}
lines=[x for x in p.read_text().splitlines() if x.partition('=')[0] not in settings]
p.write_text('\n'.join(lines+[f'{k}={v}' for k,v in settings.items()])+'\n');p.chmod(0o600)
PY
sh scripts/compose.sh up -d --no-deps web edge
docker run --rm -v "$root/.local/https/letsencrypt:/etc/letsencrypt" -v "$root/.local/https/acme:/var/www/acme" certbot/certbot:v5.10.0 certonly --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --webroot --webroot-path /var/www/acme --ip-address "$ip" --cert-name ai-ip
cat > .local/https/nginx.conf <<'NGINX'
server {
  listen 80;
  server_name _;
  location /.well-known/acme-challenge/ { root /var/www/acme; }
  location / { return 308 https://$host$request_uri; }
}
server {
  listen 443 ssl;
  server_name _;
  ssl_certificate /etc/letsencrypt/live/ai-ip/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ai-ip/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  resolver 127.0.0.11 valid=10s;
  location / { set $upstream http://web:8080; proxy_pass $upstream; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; }
}
server {
  listen 8443 ssl;
  server_name _;
  ssl_certificate /etc/letsencrypt/live/ai-ip/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ai-ip/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  resolver 127.0.0.11 valid=10s;
  client_max_body_size 20m;
  location / { set $upstream http://langfuse-web:3000; proxy_pass $upstream; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_read_timeout 120s; }
}
NGINX
sh scripts/compose.sh exec -T edge nginx -t
sh scripts/compose.sh exec -T edge nginx -s reload
sh scripts/compose.sh up -d --no-deps langfuse-web web
cat > /etc/systemd/system/ai-cert-renew.service <<EOF
[Unit]
Description=Renew ai HTTPS certificates
After=docker.service
[Service]
Type=oneshot
WorkingDirectory=$root
ExecStart=/bin/sh $root/scripts/renew-https.sh
EOF
cat > /etc/systemd/system/ai-cert-renew.timer <<'EOF'
[Unit]
Description=Check ai certificate renewal every six hours
[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
EOF
chmod +x scripts/renew-https.sh
systemctl daemon-reload
systemctl enable --now ai-cert-renew.timer
printf 'HTTPS website: https://%s/\nLangfuse: https://%s:8443/\n' "$ip" "$ip"
