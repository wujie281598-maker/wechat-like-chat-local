#!/usr/bin/env bash
set -euo pipefail

APP_NAME="doudou-im-server"
BRANCH="${1:-master}"

cd "$(dirname "$0")"

echo "==> Pull latest code: ${BRANCH}"
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull origin "${BRANCH}"

echo "==> Ensure runtime directories"
mkdir -p data uploads

echo "==> Install dependencies"
npm install

echo "==> Type check"
npm run check
npx tsc -p apps/server/tsconfig.json --noEmit

echo "==> Build web"
npm run build

echo "==> Start or restart server with PM2"
if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  pm2 restart "${APP_NAME}" --update-env
else
  pm2 start "npm --workspace apps/server run start" --name "${APP_NAME}"
fi

pm2 save

echo "==> Deploy complete"
