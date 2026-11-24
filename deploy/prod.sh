#!/usr/bin/env bash
# Production ops for onchain-signals on AWS Lightsail. Usage: npm run prod <command>
# Reads PROD_HOST, PROD_SSH_KEY, PROD_DOMAIN from the local .env.
set -euo pipefail
cd "$(dirname "$0")/.."

val() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
HOST="${PROD_HOST:-$(val PROD_HOST)}"
KEY="${PROD_SSH_KEY:-$(val PROD_SSH_KEY)}"
DOMAIN="${PROD_DOMAIN:-$(val PROD_DOMAIN)}"
KEY="${KEY/#\~/$HOME}"
[ -n "$HOST" ] && [ -n "$KEY" ] || { echo "Set PROD_HOST and PROD_SSH_KEY in .env"; exit 1; }

SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "ubuntu@$HOST")
APP=/srv/onchain-signals
NAME=onchain-signals

# (Re)create the container from an image tag. The .env is read at container creation.
run_remote() {
  "${SSH[@]}" "set -e
    docker rm -f $NAME >/dev/null 2>&1 || true
    docker run -d --name $NAME --restart unless-stopped \
      -p 127.0.0.1:4021:4021 --env-file $APP/.env -v $APP/data:/data \
      --log-opt max-size=10m --log-opt max-file=5 $1 >/dev/null
    echo $1 > $APP/current-image"
}

health() {
  local url="https://$DOMAIN/health"
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then echo "✔ healthy: $url"; return 0; fi
    sleep 3
  done
  echo "✖ not healthy: $url (see: npm run prod logs)"; return 1
}

case "${1:-help}" in
  deploy)
    npm test --silent || { echo "Tests failed: not deploying"; exit 1; }
    TAG="$NAME:$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- src package.json package-lock.json Dockerfile || echo -dirty)"
    echo "→ building $TAG (linux/amd64)"
    docker build --platform linux/amd64 -q -t "$TAG" . >/dev/null
    echo "→ uploading image"
    docker save "$TAG" | gzip -1 | "${SSH[@]}" 'gunzip | docker load -q' >/dev/null
    echo "→ restarting"
    run_remote "$TAG"
    "${SSH[@]}" "docker image prune -af --filter 'until=168h' >/dev/null" || true
    health && echo "Deployed $TAG"
    ;;
  restart) # recreate with the current image (picks up .env changes)
    run_remote "$("${SSH[@]}" "cat $APP/current-image")" && health ;;
  env)
    ssh -t -i "$KEY" "ubuntu@$HOST" "nano $APP/.env" && "$0" restart ;;
  caddy) # point Caddy (HTTPS, auto certificate) at the app for $DOMAIN
    sed "s/{{DOMAIN}}/$DOMAIN/" deploy/Caddyfile | "${SSH[@]}" "sudo tee /etc/caddy/Caddyfile >/dev/null && sudo systemctl reload caddy"
    echo "✔ Caddy serves https://$DOMAIN" ;;
  logs) "${SSH[@]}" "docker logs -f --tail 100 $NAME" ;;
  status)
    "${SSH[@]}" "docker ps --filter name=$NAME --format '{{.Image}}  {{.Status}}'; free -m | sed -n 1,3p; df -h / | tail -1"
    curl -fsS --max-time 5 "https://$DOMAIN/health" && echo ;;
  revenue) "${SSH[@]}" "docker exec $NAME node dist/revenue.js ${2:-}" ;;
  ssh) ssh -i "$KEY" "ubuntu@$HOST" ;;
  *)
    echo "npm run prod deploy|restart|env|caddy|logs|status|revenue [since]|ssh" ;;
esac
