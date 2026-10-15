#!/bin/sh
# Ships the committed code (git HEAD, nothing uncommitted) to a server and
# rebuilds it there. The server keeps its own .env and tls/ in DEPLOY_DIR.
#   DEPLOY_HOST=ubuntu@1.2.3.4 DEPLOY_KEY=~/.ssh/key sh deploy/deploy.sh
set -eu
: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. ubuntu@1.2.3.4}"
KEY_OPT=""
[ -n "${DEPLOY_KEY:-}" ] && KEY_OPT="-i $DEPLOY_KEY"
DIR="${DEPLOY_DIR:-/srv/glasstrack}"
cd "$(dirname "$0")/.."
REV=$(git rev-parse --short HEAD)
echo "Deploying $REV to $DEPLOY_HOST:$DIR"
git archive --format=tar HEAD | ssh $KEY_OPT "$DEPLOY_HOST" "mkdir -p $DIR/src && cd $DIR/src && find . -mindepth 1 -maxdepth 1 ! -name .env ! -name tls -exec rm -rf {} + && tar -xf - && echo $REV > REVISION"
ssh $KEY_OPT "$DEPLOY_HOST" "cd $DIR/src && ln -sfn $DIR/.env .env && ln -sfn $DIR/tls tls && \
  docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml up -d --build --wait --wait-timeout 300 && \
  docker image prune -f >/dev/null && docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml ps --format '{{.Service}}: {{.Status}}'"
echo "Deployed $REV"
