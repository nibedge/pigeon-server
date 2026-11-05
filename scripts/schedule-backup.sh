#!/bin/zsh
# 在这台电脑上装一个每天凌晨 4:30 跑的备份（launchd）。电脑睡着错过了，醒来补跑一次。
#   npm run backup:schedule                装上（要先 npx wrangler login）
#   npm run backup:schedule -- --uninstall 卸掉
# 隐私政策写的是备份存在运营者自己的电脑上，所以放在这里跑，不放进 GitHub Actions。
set -e
cd "$(dirname "$0")/.."
LABEL=im.nfo.pigeon.backup
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
DIR=${PIGEON_BACKUP_DIR:-$HOME/pigeon-backups}
DOMAIN=gui/$(id -u)

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ ${1:-} == --uninstall ]]; then
  rm -f "$PLIST"
  echo "已卸掉定时备份。已有的备份文件还在 $DIR"
  exit 0
fi

if ! npx wrangler whoami 2>&1 | grep -q 'You are logged in'; then
  echo "这台电脑上的 wrangler 还没登录。先跑 npx wrangler login，再跑一次这条命令。"
  exit 1
fi

mkdir -p "$DIR" "${PLIST:h}"
chmod 700 "$DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PWD/scripts/nightly-backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${$(command -v node):h}:/usr/bin:/bin</string>
    <key>PIGEON_BACKUP_DIR</key><string>$DIR</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>$DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$DIR/backup.log</string>
</dict>
</plist>
PLIST
plutil -lint -s "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "装好了：每天 4:30 备份到 $DIR，留最近 14 份，没跑成会弹系统通知。现在试跑一次：launchctl kickstart $DOMAIN/$LABEL"
