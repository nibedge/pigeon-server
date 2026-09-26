#!/usr/bin/env bash
# 必须是 bash 不是 zsh —— GitHub 的 ubuntu runner 没装 zsh，
# 用 zsh 当解释器会让整个工作流以「脚本 not found / 退出码 127」失败。
# 起一个本地 wrangler dev，跑完 API 测试再收摊。
set -e
cd "$(dirname "$0")/.."
# 没指定端口就让系统挑一个空闲的。原先写死 8799，撞上本机别的服务时 wrangler 直接起不来，
# 而报错埋在它自己的日志里，表面上只看到「API 测试没跑」、断言数凭空少了一截
PORT=${PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
# PIGEON_TEST_ADMIN 打开 /__test__/ 下的停用接口，只在这里设置；线上从不设置
# 日志各跑各的：几份工作副本同时跑测试时，共用一个日志文件会互相冒充「Ready」
LOG=$(mktemp -t pigeon_test_dev)
npx wrangler dev --local --port "$PORT" --var PIGEON_TEST_ADMIN:1 > "$LOG" 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null; rm -f $LOG" EXIT
for i in {1..60}; do
  grep -q "Ready on http" "$LOG" 2>/dev/null && break
  sleep 1
done
grep -q "Ready on http" "$LOG" || { echo "wrangler dev 起不来"; tail -20 "$LOG"; exit 1; }
# test/api*.test.mjs 逐个跑（按文件名排序），同一个 wrangler dev 实例、同一份本地 KV
for f in test/api*.test.mjs; do
  BASE="http://localhost:$PORT" node "$f"
done
