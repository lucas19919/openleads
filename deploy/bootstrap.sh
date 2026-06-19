#!/usr/bin/env bash
# Provision the Hetzner box and (re)start the CRM. Run by the Deploy CRM
# workflow over SSH, with these env vars set by the workflow:
#   IMAGE              e.g. ghcr.io/OWNER/openleads
#   GHCR_USER          the GitHub actor (for `docker login`)
#   GHCR_TOKEN         the workflow's GITHUB_TOKEN (ephemeral, masked in logs)
#   ANTHROPIC_API_KEY  optional — if the repo secret is set, baked into scraper.env
set -euo pipefail

cd /opt/openleads

# 1. Install Docker (+ compose plugin) if it isn't already present.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# 2. Secrets. api.env is generated once and then left alone, so SESSION_SECRET
#    and SERVICE_TOKEN stay stable across deploys (logins survive). scraper.env
#    is rewritten from the CI-provided key when present; otherwise created once
#    with a placeholder you can edit.
if [ ! -f api.env ]; then
  printf 'SESSION_SECRET=%s\nSERVICE_TOKEN=%s\nWEB_ORIGIN=https://crm.example.com\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > api.env
  chmod 600 api.env
  echo "==> Generated api.env"
fi
TOKEN="$(grep '^SERVICE_TOKEN=' api.env | cut -d= -f2)"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  printf 'ANTHROPIC_API_KEY=%s\nCRM_SERVICE_TOKEN=%s\nMIN_SCORE=40\n' \
    "$ANTHROPIC_API_KEY" "$TOKEN" > scraper.env
  chmod 600 scraper.env
elif [ ! -f scraper.env ]; then
  printf 'ANTHROPIC_API_KEY=PASTE_YOUR_KEY\nCRM_SERVICE_TOKEN=%s\nMIN_SCORE=40\n' "$TOKEN" > scraper.env
  chmod 600 scraper.env
  echo "==> scraper.env created with a placeholder key (set the ANTHROPIC_API_KEY repo secret to auto-fill)"
fi

# 3. Pull the freshly-built image (auth with the ephemeral workflow token) and start.
echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
export CRM_IMAGE="${IMAGE}:latest"
docker compose pull api
docker compose up -d api
docker logout ghcr.io >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

echo "==> CRM api is up on 127.0.0.1:8787"
