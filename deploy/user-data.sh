#!/bin/bash
# First-boot setup for the onchain-signals Lightsail instance (Ubuntu 24.04).
set -eux  # Lightsail runs user-data with sh: no pipefail
export DEBIAN_FRONTEND=noninteractive
# 1 GB swap: headroom for docker load on a 1 GB box
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
apt-get update
apt-get install -y docker.io caddy unattended-upgrades
systemctl enable --now docker caddy
usermod -aG docker ubuntu
mkdir -p /srv/onchain-signals/data && chown -R ubuntu:ubuntu /srv/onchain-signals
touch /srv/onchain-signals/.env && chown ubuntu:ubuntu /srv/onchain-signals/.env && chmod 600 /srv/onchain-signals/.env
touch /var/lib/cloud/instance/onchain-signals-ready
