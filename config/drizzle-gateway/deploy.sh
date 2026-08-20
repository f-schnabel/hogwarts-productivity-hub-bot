#!/bin/bash
#
# Idempotent installer for Drizzle Gateway as a native (Docker-less) systemd
# service on the OCI VPS. Run on the box as a user with sudo:
#
#   sudo config/drizzle-gateway/deploy.sh
#
# Verify the version/URL against the docs before trusting this file:
#   https://orm.drizzle.team/drizzle-gateway/overview
#
set -euo pipefail

# ---- pinned facts (verified 2025-12-16, Gateway v1.2.0) ---------------------
VERSION="1.2.0"
ARCH="linux-arm64"                       # OCI Ampere A1 (aarch64)
BASE_URL="https://pub-e240a4fd7085425baf4a7951e7611520.r2.dev"
BINARY_URL="${BASE_URL}/drizzle-gateway-${VERSION}-${ARCH}"

APP_DIR="/opt/drizzle-gateway"
BIN_PATH="${APP_DIR}/gateway"
STORE_PATH="/var/lib/drizzle-gateway"
ENV_FILE="/etc/drizzle-gateway.env"

# This script lives in <repo>/config/drizzle-gateway; the service-defs dir is
# its parent (<repo>/config), matching the existing install.sh convention.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DEFS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_SRC="${SCRIPT_DIR}/drizzle-gateway.service"
UNIT_LINK="/etc/systemd/system/drizzle-gateway.service"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: run as root (sudo $0)" >&2
    exit 1
fi

# Guard against accidentally running on the wrong architecture.
machine="$(uname -m)"
case "$ARCH" in
    linux-arm64) [[ "$machine" == "aarch64" || "$machine" == "arm64" ]] || {
        echo "ERROR: ARCH=$ARCH but uname -m=$machine. Fix ARCH in this script." >&2; exit 1; } ;;
    linux-x64)   [[ "$machine" == "x86_64" ]] || {
        echo "ERROR: ARCH=$ARCH but uname -m=$machine. Fix ARCH in this script." >&2; exit 1; } ;;
esac

echo "==> 1. system user"
if ! id drizzle >/dev/null 2>&1; then
    useradd --system --home "$APP_DIR" --create-home --shell /usr/sbin/nologin drizzle
else
    echo "    user 'drizzle' already exists"
fi
install -d -o drizzle -g drizzle -m 0755 "$APP_DIR"

echo "==> 2. binary -> $BIN_PATH"
tmp="$(mktemp)"
curl --fail --location --proto '=https' --tlsv1.2 -o "$tmp" "$BINARY_URL"
install -o drizzle -g drizzle -m 0755 "$tmp" "$BIN_PATH"
rm -f "$tmp"
echo "    sha256: $(sha256sum "$BIN_PATH" | cut -d' ' -f1)"

echo "==> 3. store dir -> $STORE_PATH"
install -d -o drizzle -g drizzle -m 0700 "$STORE_PATH"

echo "==> 4. secrets file -> $ENV_FILE (root:root 0600)"
if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    masterpass="$(openssl rand -base64 30)"
    printf 'MASTERPASS=%s\n' "$masterpass" > "$ENV_FILE"
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "    >>> GENERATED MASTERPASS (store in your password manager, then clear scrollback):"
    echo "    >>> $masterpass"
else
    echo "    $ENV_FILE already exists; leaving it untouched"
fi

echo "==> 5. systemd unit symlink"
ln -sf "$UNIT_SRC" "$UNIT_LINK"
systemctl daemon-reload
systemctl enable --now drizzle-gateway

echo "==> 6. caddy site with Basic Auth -> gateway.schnabel.dev"
CADDY_SITE="/etc/caddy/gateway.caddyfile"   # auto-imported by /etc/caddy/Caddyfile's `import *.caddyfile`
CADDY_TEMPLATE="${SERVICE_DEFS_DIR}/caddy/gateway.caddyfile.template"
if ! command -v caddy >/dev/null 2>&1; then
    echo "    caddy not found on PATH; skipping site setup"
elif [[ -f "$CADDY_SITE" ]]; then
    echo "    $CADDY_SITE already exists; leaving it untouched"
    caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
else
    read -rp "    Basic Auth username for gateway.schnabel.dev: " bauth_user
    echo "    Set the Basic Auth password (input hidden; caddy hashes it with bcrypt):"
    # caddy hash-password prompts on the tty and prints only the bcrypt hash.
    bauth_hash="$(caddy hash-password)"
    [[ -n "$bauth_user" && -n "$bauth_hash" ]] || { echo "    ERROR: empty user/hash" >&2; exit 1; }
    # awk is safe for the bcrypt hash (contains $ . / but no & or backslash).
    awk -v u="$bauth_user" -v h="$bauth_hash" \
        '{gsub(/__BASICAUTH_USER__/,u); gsub(/__BASICAUTH_HASH__/,h); print}' \
        "$CADDY_TEMPLATE" > "$CADDY_SITE"
    chown root:root "$CADDY_SITE"
    chmod 0644 "$CADDY_SITE"   # bcrypt hash only, no plaintext secret
    caddy fmt --overwrite "$CADDY_SITE"
    caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
    echo "    wrote $CADDY_SITE (Basic Auth user '$bauth_user')"
fi

echo
echo "==> status"
systemctl status drizzle-gateway --no-pager || true
echo
echo "Done. Next: run role.sql as the postgres admin (see this folder's README),"
echo "then finish first-run linking in the Gateway UI."
