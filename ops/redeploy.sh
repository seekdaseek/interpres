#!/bin/sh
# Redeploy interpres to solwatch, from the Mac: HEAD plus the built web app,
# nothing else. The PM2 cycle is the house form - delete, start, save - and no
# other process is touched. Files deleted from git are not deleted on the box.
#
#   sh ops/redeploy.sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: the working tree is not clean, and HEAD is what ships" >&2
  exit 1
fi
npm run build > /dev/null
git archive --format=tar HEAD package.json package-lock.json LICENSE packages/core/package.json packages/core/src \
    apps/server/package.json apps/server/src apps/web/package.json ops \
  | ssh -o BatchMode=yes solwatch 'tar -x -C /opt/interpres'
# The built app goes in beside the old one and replaces it in one move.
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C apps/web -cf - dist \
  | ssh -o BatchMode=yes solwatch 'cd /opt/interpres/apps/web && rm -rf dist.new && mkdir dist.new && tar -x -C dist.new --strip-components=1 && rm -rf dist && mv dist.new dist'
ssh -o BatchMode=yes solwatch 'cd /opt/interpres \
  && { cmp -s package-lock.json .deployed-lock || { npm ci --omit=dev --no-audit --no-fund > /dev/null && cp package-lock.json .deployed-lock; }; } \
  && pm2 delete interpres > /dev/null && pm2 start ops/ecosystem.config.cjs --only interpres > /dev/null && pm2 save > /dev/null \
  && for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3031/api/health && break; sleep 0.5; done \
  && curl -sS -o /dev/null -w "%{http_code} /api/health on 127.0.0.1:3031\n" http://127.0.0.1:3031/api/health'
echo "shipped $(git rev-parse --short HEAD)"
