#!/usr/bin/env bash
# 准备并托管 Paseo APK + Windows zip，供物理机浏览器下载。
# 只管理本脚本自己启动并记录的服务；绝不按端口杀未知进程。

set -euo pipefail

BUILD_ROOT=${PASEO_BUILD_ROOT:-/home/yangfei/Projects/paseo}
SCRIPT_PATH=$(readlink -f "$0")
RUNTIME_ROOT="$BUILD_ROOT/.dev/serve-dist"
DIST="$RUNTIME_ROOT/dist"
LOG="$RUNTIME_ROOT/http.log"
STATE_FILE="$RUNTIME_ROOT/server.state"
BUILD_STAMP="$RUNTIME_ROOT/build.started"
TAILSCALE_CONTAINER=paseo-tailscale-download
KEEP=0

die() {
  echo "❌ $*" >&2
  exit 1
}

validate_port() {
  local input=$1 value
  [[ "$input" =~ ^[0-9]+$ ]] || die "端口必须是数字: $input"
  value=$((10#$input))
  ((value >= 1 && value <= 65535)) || die "端口必须在 1..65535: $input"
  ((value != 6767)) || die "拒绝使用 6767：这是 Paseo 主 daemon 端口"
  printf '%s\n' "$value"
}

validate_ttl() {
  local input=$1 value
  [[ "$input" =~ ^[0-9]+$ ]] || die "存活秒数必须是数字: $input"
  value=$((10#$input))
  ((value >= 1 && value <= 604800)) || die "存活秒数必须在 1..604800: $input"
  printf '%s\n' "$value"
}

load_version() {
  local package_json="$BUILD_ROOT/package.json"
  [[ -f "$package_json" ]] || die "找不到版本源: $package_json"
  VER=$(node -e '
    const pkg = require(process.argv[1]);
    if (typeof pkg.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(pkg.version)) process.exit(1);
    process.stdout.write(pkg.version);
  ' "$package_json") || die "无法从 $package_json 读取安全版本号"
  APK="$BUILD_ROOT/packages/app/android/app/build/outputs/apk/release/app-release.apk"
  ZIP="$BUILD_ROOT/packages/desktop/release/Paseo-Setup-${VER}-x64.zip"
}

prepare_build() {
  local stamp_tmp
  load_version
  mkdir -p "$RUNTIME_ROOT"
  rm -f -- "$APK" "$ZIP"
  stamp_tmp="${BUILD_STAMP}.tmp.$$"
  printf '%s\n' "$VER" >"$stamp_tmp"
  mv -f -- "$stamp_tmp" "$BUILD_STAMP"
  echo "✅ 已开始 Paseo $VER 构建并清除精确目标产物"
  echo "   APK: $APK"
  echo "   ZIP: $ZIP"
}

require_current_artifacts() {
  local stamped_version
  [[ -f "$BUILD_STAMP" ]] || die "缺少本轮构建标记；先运行: bash $SCRIPT_PATH prepare-build"
  IFS= read -r stamped_version <"$BUILD_STAMP"
  [[ "$stamped_version" == "$VER" ]] ||
    die "构建标记版本是 $stamped_version，当前版本是 $VER；请重新完整打包"
  [[ -f "$APK" ]] || die "找不到本轮 APK: $APK"
  [[ -f "$ZIP" ]] || die "找不到本轮 Windows zip: $ZIP"
  [[ "$APK" -nt "$BUILD_STAMP" ]] || die "APK 早于本轮构建标记，拒绝分发旧包: $APK"
  [[ "$ZIP" -nt "$BUILD_STAMP" ]] || die "Windows zip 早于本轮构建标记，拒绝分发旧包: $ZIP"
}

port_is_listening() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

load_owned_state() {
  [[ -f "$STATE_FILE" ]] || return 1
  read -r STATE_PID STATE_PORT STATE_TTL STATE_STARTED <"$STATE_FILE" || return 1
  [[ "$STATE_PID" =~ ^[0-9]+$ && "$STATE_PORT" =~ ^[0-9]+$ && "$STATE_TTL" =~ ^[0-9]+$ &&
    "$STATE_STARTED" =~ ^[0-9]+$ ]] || return 1
}

owned_server_is_running() {
  local pgid sid index
  local -a argv
  load_owned_state || return 1
  kill -0 "$STATE_PID" 2>/dev/null || return 1
  pgid=$(ps -o pgid= -p "$STATE_PID" 2>/dev/null | tr -d ' ') || return 1
  [[ "$pgid" == "$STATE_PID" ]] || return 1
  sid=$(ps -o sid= -p "$STATE_PID" 2>/dev/null | tr -d ' ') || return 1
  [[ "$sid" == "$STATE_PID" ]] || return 1
  mapfile -d '' -t argv <"/proc/$STATE_PID/cmdline" || return 1
  for ((index = 0; index + 1 < ${#argv[@]}; index++)); do
    [[ "${argv[$index]}" == "$SCRIPT_PATH" && "${argv[$((index + 1))]}" == __serve ]] && return 0
  done
  return 1
}

owned_session_pids() {
  ps -eo pid=,sid= | awk -v sid="$1" '$2 == sid { print $1 }'
}

stop_owned_server() {
  local pid session_stopped=0
  local -a session_pids
  owned_server_is_running || return 1
  pid=$STATE_PID
  mapfile -t session_pids < <(owned_session_pids "$pid")
  ((${#session_pids[@]} > 0)) || die "受管下载服务会话为空；保留状态以便安全排查"
  kill -TERM "${session_pids[@]}" 2>/dev/null || true
  for _ in {1..30}; do
    if [[ -z "$(owned_session_pids "$pid")" ]]; then
      session_stopped=1
      break
    fi
    sleep 0.1
  done
  if ((session_stopped == 0)); then
    mapfile -t session_pids < <(owned_session_pids "$pid")
    ((${#session_pids[@]} > 0)) && kill -KILL "${session_pids[@]}" 2>/dev/null || true
    for _ in {1..30}; do
      if [[ -z "$(owned_session_pids "$pid")" ]]; then
        session_stopped=1
        break
      fi
      sleep 0.1
    done
  fi
  ((session_stopped == 1)) || die "受管下载服务会话未退出；保留状态以便安全排查"
  rm -f -- "$STATE_FILE"
  rm -rf -- "$DIST"
  STOPPED_PID=$pid
}

internal_cleanup() {
  local pid port ttl started
  if [[ -f "$STATE_FILE" ]] && read -r pid port ttl started <"$STATE_FILE" && [[ "$pid" == "$$" ]]; then
    rm -f -- "$STATE_FILE"
  fi
  rm -rf -- "$DIST"
}

run_internal_server() {
  local port ttl
  port=$(validate_port "$1")
  ttl=$(validate_ttl "$2")
  trap internal_cleanup EXIT
  trap 'exit 143' TERM INT
  cd "$DIST"
  timeout "$ttl" python3 -m http.server "$port" --bind 0.0.0.0
}

refresh_files() {
  local temp
  mkdir -p "$RUNTIME_ROOT" "$DIST"
  temp=$(mktemp -d "$RUNTIME_ROOT/stage.XXXXXX")
  if ! cp -- "$APK" "$temp/paseo-android-${VER}.apk" ||
    ! cp -- "$ZIP" "$temp/paseo-desktop-win-x64-${VER}.zip"; then
    rm -rf -- "$temp"
    die "复制分发产物失败"
  fi
  find "$DIST" -mindepth 1 -maxdepth 1 -type f -delete
  mv -- "$temp"/* "$DIST"/
  rmdir "$temp"
}

remain_str() {
  local elapsed remaining now
  now=$(date +%s)
  elapsed=$((now - STATE_STARTED))
  remaining=$((STATE_TTL - elapsed))
  ((remaining < 0)) && remaining=0
  printf '，剩余存活约 %dh%dm' "$((remaining / 3600))" "$(((remaining % 3600) / 60))"
}

vm_ip() {
  local ip
  ip=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[0-9.]+' | grep -v '^127\.' | grep -v '^198\.18\.' | head -1) || true
  echo "${ip:-<VM_IP>}"
}

# 优先复用原生 Tailscale；本机未安装时，复用已授权的下载容器。
tailnet_ip() {
  local ip running purpose _

  [[ "${PASEO_SKIP_TAILSCALE:-}" == 1 ]] && return 1

  if command -v tailscale >/dev/null 2>&1; then
    ip=$(tailscale ip -4 2>/dev/null | head -1) || true
    [[ -n "$ip" ]] && {
      echo "$ip"
      return 0
    }
  fi

  command -v docker >/dev/null 2>&1 || return 1
  purpose=$(docker inspect --format '{{index .Config.Labels "com.paseo.purpose"}}' "$TAILSCALE_CONTAINER" 2>/dev/null) || return 1
  [[ "$purpose" == artifact-download ]] || return 1
  running=$(docker inspect --format '{{.State.Running}}' "$TAILSCALE_CONTAINER" 2>/dev/null) || return 1
  [[ "$running" == true ]] || docker start "$TAILSCALE_CONTAINER" >/dev/null 2>&1 || return 1

  for _ in 1 2 3 4 5; do
    ip=$(docker exec "$TAILSCALE_CONTAINER" tailscale --socket=/tmp/tailscaled.sock ip -4 2>/dev/null | head -1) || true
    [[ -n "$ip" ]] && {
      echo "$ip"
      return 0
    }
    sleep 1
  done
  return 1
}

show_access_urls() {
  local port=$1 tailnet
  echo " 物理机浏览器访问:  http://${IP}:${port}/"
  if tailnet=$(tailnet_ip); then
    echo " Tailscale 私有直连: http://${tailnet}:${port}/"
  else
    echo " Tailscale: 未就绪（不影响局域网下载）"
  fi
}

start_server() {
  local pid started state_tmp ready=0
  started=$(date +%s)
  setsid bash "$SCRIPT_PATH" __serve "$PORT" "$TTL" >"$LOG" 2>&1 &
  pid=$!
  state_tmp="${STATE_FILE}.tmp.$$"
  umask 077
  printf '%s %s %s %s\n' "$pid" "$PORT" "$TTL" "$started" >"$state_tmp"
  mv -f -- "$state_tmp" "$STATE_FILE"

  for _ in {1..30}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    if port_is_listening "$PORT"; then
      ready=1
      break
    fi
    sleep 0.1
  done

  if ((ready == 0)); then
    stop_owned_server || true
    rm -f -- "$STATE_FILE"
    rm -rf -- "$DIST"
    die "下载服务启动失败；查看日志: $LOG"
  fi
}

usage() {
  cat <<EOF
用法:
  bash $SCRIPT_PATH prepare-build       # 构建前写标记并清除精确目标产物
  bash $SCRIPT_PATH [PORT] [TTL]        # 默认端口 8800、存活 10800 秒
  bash $SCRIPT_PATH keep [PORT] [TTL]   # 刷新本轮产物，不重置已有计时
  bash $SCRIPT_PATH stop                # 只停止本脚本管理的下载服务
EOF
}

case "${1:-}" in
  __serve)
    [[ $# == 3 ]] || exit 2
    run_internal_server "$2" "$3"
    exit
    ;;
  prepare-build)
    [[ $# == 1 ]] || die "prepare-build 不接受额外参数"
    prepare_build
    exit
    ;;
  stop)
    [[ $# == 1 ]] || die "stop 不接受端口参数"
    if stop_owned_server; then
      echo "已停服 (PID=$STOPPED_PID) 并清理分发目录"
    else
      rm -f -- "$STATE_FILE"
      echo "未发现本脚本管理的下载服务；未触碰其他进程"
    fi
    exit
    ;;
  keep)
    KEEP=1
    shift
    ;;
  restart)
    shift
    ;;
  -h | --help)
    usage
    exit
    ;;
esac

[[ $# -le 2 ]] || die "参数过多；使用 --help 查看用法"
PORT=$(validate_port "${1:-8800}")
TTL=$(validate_ttl "${2:-10800}")
load_version
require_current_artifacts
mkdir -p "$RUNTIME_ROOT"

if owned_server_is_running; then
  if ((KEEP == 1)); then
    [[ "$STATE_PORT" == "$PORT" ]] || die "已有受管服务在端口 $STATE_PORT，keep 不能改为 $PORT"
    port_is_listening "$PORT" || die "受管进程存在但端口 $PORT 未监听；请先 stop 后重试"
    remaining=$(remain_str)
    refresh_files
    IP=$(vm_ip)
    echo "============================================"
    echo " ♻️  已沿用端口 ${PORT} 的服务并刷新本轮产物${remaining}"
    echo " 版本: $VER"
    show_access_urls "$PORT"
    echo "============================================"
    exit
  fi
  old_port=$STATE_PORT
  stop_owned_server
  echo " ♻️  已停止本脚本管理的旧服务 (PID=$STOPPED_PID, 端口=$old_port)"
else
  rm -f -- "$STATE_FILE"
fi

port_is_listening "$PORT" && die "端口 $PORT 已被其他进程占用；为避免误杀，拒绝启动"
refresh_files
start_server
IP=$(vm_ip)

echo "============================================"
echo " ✅ Paseo 下载服务已启动并确认监听"
echo " 版本: $VER   端口: $PORT"
echo " 存活: ${TTL}s ($((TTL / 3600))h$(((TTL % 3600) / 60))m)，到点自动停服并清理"
show_access_urls "$PORT"
echo "   - paseo-android-${VER}.apk"
echo "   - paseo-desktop-win-x64-${VER}.zip"
echo " 提前停服: bash $SCRIPT_PATH stop"
echo "============================================"
