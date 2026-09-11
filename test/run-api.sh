#!/bin/zsh
# 起一个本地 wrangler dev，跑完 API 测试再收摊。
set -e
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
npx wrangler dev --local --port "$PORT" > /tmp/pigeon_test_dev.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null" EXIT
for i in {1..60}; do
  grep -q "Ready on http" /tmp/pigeon_test_dev.log 2>/dev/null && break
  sleep 1
done
grep -q "Ready on http" /tmp/pigeon_test_dev.log || { echo "wrangler dev 起不来"; tail -20 /tmp/pigeon_test_dev.log; exit 1; }
BASE="http://localhost:$PORT" node test/api.test.mjs
