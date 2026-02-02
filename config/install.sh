#!/bin/bash

set -euo pipefail

# Get the directory where this script is located
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Make all parent directories traversable
path="$REPO_DIR"
while [[ "$path" != "/" ]]; do
    sudo chmod o+x "$path"
    path="$(dirname "$path")"
done
chmod -R o+rX "$REPO_DIR"

# Create symlinks
sudo ln -sf "$REPO_DIR/grafana/grafana.ini" /etc/grafana/grafana.ini
sudo ln -sf "$REPO_DIR/loki/config.yml" /etc/loki/config.yml
sudo ln -sf "$REPO_DIR/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml
sudo ln -sf "$REPO_DIR/promtail/config.yml" /etc/promtail/config.yml

sudo ln -sf "$REPO_DIR/loki/loki.service" /etc/systemd/system/loki.service
sudo ln -sf "$REPO_DIR/prometheus/prometheus.service" /etc/systemd/system/prometheus.service
sudo ln -sf "$REPO_DIR/promtail/promtail.service" /etc/systemd/system/promtail.service

# Ensure systemd overrides for services with ProtectHome
sudo mkdir -p /etc/systemd/system/grafana-server.service.d
echo -e "[Service]\nProtectHome=false" | sudo tee /etc/systemd/system/grafana-server.service.d/override.conf > /dev/null


echo "Symlinks created and permissions set."
# Reload and restart services
sudo systemctl daemon-reload
sudo systemctl restart grafana-server prometheus loki promtail
echo "Services restarted"


echo "Setting up Hogwarts Bot service..."
sed -e "s|__REPO_DIR__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
    "$REPO_DIR/app/hogwarts-bot.service.template" > "$REPO_DIR/app/hogwarts-bot.service"

mkdir -p ~/.config/systemd/user
ln -sf "$REPO_DIR/app/hogwarts-bot.service" ~/.config/systemd/user/hogwarts-bot.service
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
systemctl --user restart hogwarts-bot
echo "Hogwarts Bot service set up and restarted."
