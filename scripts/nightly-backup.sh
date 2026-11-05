#!/bin/zsh
# 导出、校验，通过了才删旧的，留最近 14 份。launchd 每天跑一次（见 scripts/schedule-backup.sh）。
# 没跑成弹一条系统通知：备份默默停了，要到恢复那天才发现。多给的参数原样传给 npm run backup。
set -u
cd "$(dirname "$0")/.."
DIR=${PIGEON_BACKUP_DIR:-$HOME/pigeon-backups}
KEEP=14

fail() {
  echo "$(date '+%F %T') $1"
  osascript -e "display notification \"$1\" with title \"信鸽备份没成\"" 2>/dev/null
  exit 1
}

npm run -s backup -- --out "$DIR" "$@" || fail "导出失败，看 $DIR/backup.log（Cloudflare 登录过期的话跑 npx wrangler login）"
newest=$(ls -t "$DIR"/pigeon-kv-*.json.gz 2>/dev/null | head -1)
[[ -n $newest ]] || fail "导出之后没找到备份文件"
npm run -s backup -- --verify "$newest" || fail "备份没通过校验：$newest"
ls -t "$DIR"/pigeon-kv-*.json.gz | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
echo "$(date '+%F %T') 备份完成：$newest"
