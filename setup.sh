#!/usr/bin/env bash
# Ji Fire order server installer for an Amazon (EC2 / Lightsail) Linux server.
# Installs Node.js + Caddy (automatic HTTPS), downloads the server, asks for
# the Shopify keys, and runs everything as services that restart on reboot.
#
#   curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/setup.sh | sudo bash
set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/jifire178-bit/jifire-server/main}"
APP_DIR=/opt/jifire-orders
NODE_VERSION=22.12.0

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
# Values can come from the environment (EC2 User data) or be typed in.
ask() {
  local v=""
  if [ -r /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then read -r -p "$1" v < /dev/tty || true; fi
  echo "$v"
}

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }

case "$(uname -m)" in
  x86_64) NARCH=x64; CARCH=amd64 ;;
  aarch64|arm64) NARCH=arm64; CARCH=arm64 ;;
  *) echo "Unsupported CPU $(uname -m)"; exit 1 ;;
esac

say "1/6 Installing Node.js $NODE_VERSION"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NARCH.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v

say "2/6 Installing Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CARCH" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy

say "3/6 Downloading the order server"
id jifire >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin jifire
mkdir -p "$APP_DIR/data"
for f in server.js package.json env.example; do
  curl -fsSL "$REPO_RAW/$f" -o "$APP_DIR/$f"
done

say "4/6 Settings"
IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
DOMAIN_DEFAULT="$(echo "$IP" | tr . -).sslip.io"
if [ -f "$APP_DIR/.env" ]; then
  echo "Existing .env kept ($APP_DIR/.env)."
  DOMAIN=$(grep '^PUBLIC_URL=' "$APP_DIR/.env" | sed 's#PUBLIC_URL=https://##')
  # Automatic sslip.io address: follow the server's current IP.
  if [ -z "${JF_DOMAIN:-}" ] && [[ "$DOMAIN" == *.sslip.io ]] && [ "$DOMAIN" != "$DOMAIN_DEFAULT" ]; then
    DOMAIN=$DOMAIN_DEFAULT
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$APP_DIR/.env"
    echo "IP changed: new link https://$DOMAIN"
  fi
else
  echo "Server IP: $IP"
  DOMAIN=${JF_DOMAIN:-$(ask "Domain (Enter = $DOMAIN_DEFAULT): ")}
  DOMAIN=${DOMAIN:-$DOMAIN_DEFAULT}
  CID=${SHOPIFY_CLIENT_ID:-$(ask "Shopify Client ID: ")}
  CSECRET=${SHOPIFY_CLIENT_SECRET:-$(ask "Shopify Client secret: ")}
  if [ -z "$CID" ] || [ -z "$CSECRET" ]; then echo "Missing Shopify Client ID/secret"; exit 1; fi
  cp "$APP_DIR/env.example" "$APP_DIR/.env"
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$APP_DIR/.env"
  sed -i "s#^SHOPIFY_CLIENT_ID=.*#SHOPIFY_CLIENT_ID=$CID#" "$APP_DIR/.env"
  sed -i "s#^SHOPIFY_CLIENT_SECRET=.*#SHOPIFY_CLIENT_SECRET=$CSECRET#" "$APP_DIR/.env"
fi
chown -R jifire:jifire "$APP_DIR"
chmod 600 "$APP_DIR/.env"

say "5/6 Creating services"
cat > /etc/systemd/system/jifire-orders.service <<EOF
[Unit]
Description=Ji Fire order server
After=network-online.target
[Service]
User=jifire
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:8080
}
EOF
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
[Service]
User=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable jifire-orders >/dev/null 2>&1
systemctl restart jifire-orders
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

say "6/6 Checking"
sleep 4
if curl -fsS http://127.0.0.1:8080/health >/dev/null; then echo "Order server: OK"; else
  echo "Order server failed:"; journalctl -u jifire-orders -n 20 --no-pager; fi
for i in $(seq 1 20); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
if [ "${OK:-}" = 1 ]; then
  printf '\n\033[1;32m✅ Done! Server link:\033[0m  https://%s\n\n' "$DOMAIN"
else
  printf '\n\033[1;31mHTTPS not ready.\033[0m Open ports 80 and 443 in the AWS firewall, then run:\n  sudo systemctl restart caddy\nLink: https://%s\n' "$DOMAIN"
fi
echo "Logs:  sudo journalctl -u jifire-orders -f"
echo "Edit settings:  sudo nano $APP_DIR/.env  then  sudo systemctl restart jifire-orders"
