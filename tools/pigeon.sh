#!/bin/sh
# pigeon —— 在命令行里推一条信鸽通知，或者跑完一条命令把结果推到手机上。
#
#   pigeon send "标题" "正文"          推一条（只给一个参数时它是正文；正文写 - 就从标准输入读）
#   pigeon run -- make release         跑命令，结束后推「成功 / 失败 · 退出码 · 用时 · 最后 5 行输出」，
#                                      失败的按时效性提醒；pigeon 自己的退出码就是这条命令的退出码
#
# 选项写在 send / run 后面、命令之前：
#   --level passive|active|timeSensitive   --id <同一件事的标识>   --url <点开的链接>   --group <分组>
#   --repeat <分钟>（每隔几分钟再提醒，直到有人点「知道了」）   --status firing|resolved
#   run 另有：--title <标题>（默认是命令本身）  --quiet（成功时静默送达，只有失败才响）
#
# 推送 key：环境变量 PIGEON_KEY，或者文件 ~/.config/pigeon/key 的第一行。写 key、发送令牌（st_ 开头）
# 或整个推送地址都行，在信鸽 App 的通道设置里复制。key 经标准输入交给 curl，不出现在命令行参数里（别人用 ps 看不到）。
# 自建或测试时用 PIGEON_SERVER 换服务器地址（默认 https://nfo.im）。
#
# 只用 POSIX sh、curl 和系统自带的命令，不装任何依赖；整个文件就是全部实现，可以逐行审计。
# 推出去的内容以明文经过服务器；需要端到端加密，用 /tools/pigeon-send.mjs。

set -u

SERVER=${PIGEON_SERVER:-https://nfo.im}

say() { printf 'pigeon：%s\n' "$1" >&2; }
die() { say "$1"; exit "${2:-2}"; }

usage() {
  cat <<'EOF'
用法：
  pigeon send [选项] "标题" "正文"       推一条；只给一个参数时它是正文，正文写 - 就从标准输入读
  pigeon run [选项] -- 命令 参数…        跑命令，结束后把成功或失败推到手机上
选项：
  --level passive|active|timeSensitive  --id <标识>  --url <链接>  --group <分组>
  --repeat <分钟>  --status firing|resolved  --title <标题>（run 用）  --quiet（run 成功时静默送达）
推送 key：环境变量 PIGEON_KEY，或 ~/.config/pigeon/key 的第一行（在信鸽 App 的通道设置里复制；发送令牌也行）
EOF
}

# 选项
opt_level=""
opt_id=""
opt_url=""
opt_group=""
opt_repeat=""
opt_status=""
opt_title=""
opt_quiet=""

# ── 推送 key 与地址 ──────────────────────────────────────────────────

# 读出推送 key（或整个推送地址）。PIGEON_KEY 优先，其次配置文件
read_key() {
  key=${PIGEON_KEY:-}
  if [ -z "$key" ]; then
    file="${XDG_CONFIG_HOME:-$HOME/.config}/pigeon/key"
    if [ -r "$file" ]; then
      key=$(sed -n '1p' "$file" | tr -d ' \t\r\n')
    fi
  fi
  [ -n "$key" ] || die "没有推送 key：设环境变量 PIGEON_KEY，或者写进 ~/.config/pigeon/key（在信鸽 App 的通道设置里复制）"
}

# ── curl 配置 ────────────────────────────────────────────────────────
# 所有参数（地址、key、内容）写成 curl 的配置从标准输入交给它：命令行参数谁都能用 ps 看到

# 一个值写进 curl 配置的双引号里：反斜杠、双引号转义，换行写成 \n，制表符写成 \t，回车去掉
quote() {
  printf '%s' "$1" | tr -d '\r' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" |
    awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
}

# 一行 data-urlencode 配置：field 名、值。值为空不写
field() {
  [ -n "$2" ] || return 0
  printf 'data-urlencode = "%s=%s"\n' "$1" "$(quote "$2")"
}

# 发出去：$1 标题、$2 正文，另加各个选项。成功返回 0；失败打印服务器给的原因、返回 1
deliver() {
  command -v curl >/dev/null 2>&1 || die "需要 curl：请先安装 curl"
  read_key
  case $key in
    http://* | https://*)
      target="$key"
      auth=""
      ;;
    *)
      case $key in
        *[!A-Za-z0-9_-]*) die "推送 key 里有不该有的字符：请从信鸽 App 的通道设置里原样复制" ;;
      esac
      # 43 位以上的是通道加密密钥（pigeon-send.mjs 读的也是 PIGEON_KEY），不是推送 key。别把它发给服务器。
      # 发送令牌（st_ 加 43 位）也够长，但它本来就是推送用的，照发
      case $key in
        st_*) ;;
        *)
          if [ "${#key}" -ge 43 ]; then
            die "PIGEON_KEY 看起来是通道加密密钥，不是推送 key：推送 key 在推送地址里 ${SERVER#*://}/ 后面那一段"
          fi
          ;;
      esac
      target="${SERVER%/}/"
      auth="$key"
      ;;
  esac

  out=$(
    {
      printf 'url = "%s"\n' "$(quote "$target")"
      [ -z "$auth" ] || printf 'header = "Authorization: Bearer %s"\n' "$auth"
      printf 'header = "User-Agent: pigeon.sh/1"\n'
      field title "$1"
      field body "$2"
      field level "$opt_level"
      field id "$opt_id"
      field url "$opt_url"
      field group "$opt_group"
      field repeat "$opt_repeat"
      field status "$opt_status"
      printf 'silent\nshow-error\nmax-time = 20\nretry = 2\n'
      printf 'write-out = "\\n%%{http_code}"\n'
    } | curl --config - 2>&1
  )
  code=$(printf '%s\n' "$out" | tail -n 1)
  case $code in
    2??) return 0 ;;
  esac
  reason=$(printf '%s\n' "$out" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$reason" ] || reason=$(printf '%s\n' "$out" | sed '$d' | head -n 3)
  say "推送失败（HTTP ${code:-?}）：${reason:-没有回应}"
  return 1
}

# ── 选项 ─────────────────────────────────────────────────────────────

# 解析选项，剩下的参数留给调用方。选项后面少了值、不认识的选项：报错退出（退出码 2）
parse_options() {
  consumed=0
  while [ $# -gt 0 ]; do
    case $1 in
      --level | --id | --url | --group | --repeat | --status | --title)
        [ $# -ge 2 ] || die "$1 后面少了值"
        case $1 in
          --level) opt_level=$2 ;;
          --id) opt_id=$2 ;;
          --url) opt_url=$2 ;;
          --group) opt_group=$2 ;;
          --repeat) opt_repeat=$2 ;;
          --status) opt_status=$2 ;;
          --title) opt_title=$2 ;;
        esac
        shift 2
        consumed=$((consumed + 2))
        ;;
      --quiet)
        opt_quiet=1
        shift
        consumed=$((consumed + 1))
        ;;
      --)
        consumed=$((consumed + 1))
        return 0
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      --*) die "不认识的选项 $1（pigeon --help 看用法）" ;;
      *) return 0 ;;
    esac
  done
}

# ── send ─────────────────────────────────────────────────────────────

cmd_send() {
  parse_options "$@"
  shift "$consumed"
  case $# in
    1) title="" body=$1 ;;
    2) title=$1 body=$2 ;;
    *) die "send 要一个或两个参数：pigeon send \"标题\" \"正文\"（值里有空格时加引号）" ;;
  esac
  # 正文写 - ：从标准输入读（比如 df -h | pigeon send "磁盘" -）
  [ "$body" != "-" ] || body=$(cat)
  [ -n "$title$body" ] || die "没有内容可推"
  deliver "$title" "$body" || exit 1
}

# ── run ──────────────────────────────────────────────────────────────

# 秒 → 「45 秒」「3 分 12 秒」「1 小时 2 分」
duration() {
  s=$1
  if [ "$s" -lt 60 ]; then
    printf '%s 秒' "$s"
  elif [ "$s" -lt 3600 ]; then
    printf '%s 分 %s 秒' $((s / 60)) $((s % 60))
  else
    printf '%s 小时 %s 分' $((s / 3600)) $((s % 3600 / 60))
  fi
}

cmd_run() {
  parse_options "$@"
  shift "$consumed"
  [ $# -gt 0 ] || die "run 后面要跟命令：pigeon run -- make release"
  read_key

  log=$(mktemp "${TMPDIR:-/tmp}/pigeon.XXXXXX") || die "建不了临时文件"
  trap 'rm -f "$log" "$log.rc"' EXIT
  # Ctrl-C 先交给命令去处理；pigeon 自己不退，等它停下来把「中断了」推出去
  interrupted=""
  trap 'interrupted=1' INT TERM

  start=$(date +%s)
  # 标准输出和标准错误并在一起，照常显示在终端上，同时记下来取最后几行
  { "$@" 2>&1; echo $? >"$log.rc"; } | tee "$log"
  end=$(date +%s)
  rc=$(cat "$log.rc" 2>/dev/null)
  if [ -z "$rc" ]; then
    # 命令被信号打断，没来得及写下退出码
    if [ -n "$interrupted" ]; then rc=130; else rc=1; fi
  fi
  trap - INT TERM

  esc=$(printf '\033')
  cr=$(printf '\r')
  # 最后 5 行：去掉终端颜色、进度条的回车覆盖，太长的只留结尾
  tail_lines=$(tail -n 5 "$log" | sed -e "s/${esc}\[[0-9;?]*[A-Za-z]//g" -e "s/.*${cr}//" | tail -c 2000)

  what=${opt_title:-$*}
  host=$(hostname 2>/dev/null || uname -n)
  elapsed=$(duration $((end - start)))
  if [ "$rc" -eq 0 ]; then
    title="✅ 成功 · $what"
    [ -n "$opt_level" ] || { [ -z "$opt_quiet" ] || opt_level=passive; }
    [ -z "$opt_id" ] || [ -n "$opt_status" ] || opt_status=resolved
  else
    if [ "$rc" -eq 130 ] && [ -n "$interrupted" ]; then
      title="⏹ 中断 · $what"
    else
      title="❌ 失败 · $what"
    fi
    [ -n "$opt_level" ] || opt_level=timeSensitive
    [ -z "$opt_id" ] || [ -n "$opt_status" ] || opt_status=firing
  fi
  body="退出码 $rc · 用时 $elapsed · $host"
  if [ -n "$tail_lines" ]; then
    body="$body
最后 5 行：
$tail_lines"
  fi
  deliver "$title" "$body" || say "命令已跑完（退出码 $rc），但通知没推出去"
  exit "$rc"
}

# ── 入口 ─────────────────────────────────────────────────────────────

[ $# -gt 0 ] || { usage >&2; exit 2; }
sub=$1
shift
case $sub in
  send) cmd_send "$@" ;;
  run) cmd_run "$@" ;;
  -h | --help | help) usage ;;
  *) die "不认识的子命令 $sub：用 pigeon send 或 pigeon run（pigeon --help 看用法）" ;;
esac
