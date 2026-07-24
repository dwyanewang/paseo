#!/usr/bin/env bash
# 起 paseo 产物下载服务，供物理机(172.16.21.200 等)浏览器拉取。
# 幂等且自愈：重跑本脚本会刷新为最新产物，并【重新计时 3 小时】（用户偏好：每次打包重置成 3h）。
#   - 已有服务在跑 → 停旧的、用新文件重起、计时归零，不会端口冲突。
#   - 没有服务     → 直接新建。
# 服务由 timeout 控制存活时长(默认 3 小时)，到点自动停服并清理 staging 目录。
#
# 用法:
#   bash serve-dist.sh                # 端口 8800，刷新文件并(重新)计时 3 小时
#   bash serve-dist.sh 8800 10800     # 自定义 端口 存活秒数
#   bash serve-dist.sh keep           # 沿用在跑的服务、只刷新文件，不重置计时
#   bash serve-dist.sh stop           # 停服 + 清理
#
# 物理机浏览器访问:  http://<VM_IP>:<端口>/   (VM_IP 见脚本输出)

set -uo pipefail

DIST=/tmp/paseo-dist
LOG=/tmp/paseo-http.log

# 在指定端口监听的 python PID
listen_pid() { ss -ltnp 2>/dev/null | grep -E ":${1} " | grep -oP 'pid=\K[0-9]+' | head -1; }

# 杀掉端口上的服务（连同 timeout 看门狗父进程），其 wrapper 会自行 rm -rf $DIST
kill_on_port() {
  local pid pp
  pid=$(listen_pid "${1:-8800}")
  [ -z "$pid" ] && return 1
  pp=$(awk '/^PPid:/{print $2}' /proc/"$pid"/status 2>/dev/null)   # timeout 看门狗
  [ -n "$pp" ] && kill "$pp" 2>/dev/null     # 杀 timeout → wrapper 继续执行 rm -rf $DIST
  kill "$pid" 2>/dev/null
  echo "$pid"
}

# 计算某服务剩余存活（keep 模式展示用）
remain_str() {
  local pid="$1" pp cl ttl el rem
  pp=$(awk '/^PPid:/{print $2}' /proc/"$pid"/status 2>/dev/null)
  cl=$(tr '\0' ' ' < /proc/"$pp"/cmdline 2>/dev/null)
  case "$cl" in
    timeout\ *) ttl=$(echo "$cl" | awk '{print $2}')
                el=$(ps -o etimes= -p "$pp" 2>/dev/null | tr -d ' ')
                rem=$(( ttl - el )); [ "$rem" -lt 0 ] && rem=0
                echo "，剩余存活约 $((rem/3600))h$(( (rem%3600)/60 ))m" ;;
  esac
}

refresh_files() {
  mkdir -p "$DIST"; rm -f "$DIST"/*
  cp "$APK" "$DIST/paseo-android-${VER}.apk"
  cp "$ZIP" "$DIST/paseo-desktop-win-x64-${VER}.zip"
}

vm_ip() {
  local ip
  ip=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[0-9.]+' | grep -v '^127\.' | grep -v '^198\.18\.' | head -1)
  echo "${ip:-<VM_IP>}"
}

# ---- 子命令 ----
KEEP=0
case "${1:-}" in
  stop)
    pid=$(kill_on_port 8800) && echo "已停服 (PID=$pid)" || echo "未发现运行中的服务"
    sleep 1; rm -rf "$DIST"; echo "已清理 $DIST"; exit 0 ;;
  keep)    KEEP=1; shift ;;
  restart) shift ;;          # 兼容旧用法：等同默认
esac

PORT="${1:-8800}"
TTL="${2:-10800}"           # 默认 3h

APK=~/Projects/paseo/packages/app/android/app/build/outputs/apk/release/app-release.apk
ZIP="$(ls -t ~/Projects/paseo/packages/desktop/release/*.zip 2>/dev/null | head -1)"   # 按修改时间取最新，避免 release/ 残留旧版本 zip 被字母序选中
[ -f "$APK" ] || { echo "❌ 找不到 APK: $APK (先完成安卓打包)"; exit 1; }
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "❌ 找不到 Windows zip (先完成桌面端打包)"; exit 1; }
zip_basename=$(basename "$ZIP")
case "$zip_basename" in
  Paseo-Setup-*-x64.zip)
    VER=${zip_basename#Paseo-Setup-}
    VER=${VER%-x64.zip}
    ;;
  *) VER=unknown ;;
esac

# 只保留最近 2 个打包 zip，更旧的连同其 blockmap 一起删除，避免 release/ 越积越多
ls -t ~/Projects/paseo/packages/desktop/release/*.zip 2>/dev/null | tail -n +3 | while read -r old; do
  rm -f "${old%.zip}".zip "${old%.zip}".zip.blockmap "${old%.zip}".exe.blockmap
done

IP=$(vm_ip)
EXIST=$(listen_pid "$PORT")

# ---- keep 模式：沿用在跑的服务，仅原地刷新文件，不重置计时 ----
if [ "$KEEP" = 1 ] && [ -n "$EXIST" ]; then
  rem=$(remain_str "$EXIST")
  refresh_files
  echo "============================================"
  echo " ♻️  已【沿用】端口 ${PORT} 的服务并刷新为最新产物${rem}"
  echo " 版本: $VER   访问: http://${IP}:${PORT}/"
  echo "============================================"
  exit 0
fi

# ---- 默认：先停旧服务（若有），等其 wrapper 清完目录，再用新文件重起、计时归零 ----
if [ -n "$EXIST" ]; then
  old=$(kill_on_port "$PORT")
  sleep 2                              # 等 wrapper 的 rm -rf $DIST 执行完，避免误删新文件
  echo " ♻️  已停止旧服务 (PID=$old)，用最新产物重起并重新计时 ${TTL}s"
fi

refresh_files
setsid bash -c "cd '$DIST' && timeout $TTL python3 -m http.server $PORT --bind 0.0.0.0; rm -rf '$DIST'" \
  >"$LOG" 2>&1 &
sleep 1

echo "============================================"
echo " ✅ paseo 下载服务已启动"
echo " 版本: $VER   端口: $PORT"
echo " 存活: ${TTL}s ($((TTL/3600))h$(( (TTL%3600)/60 ))m)，到点自动停服并清理"
echo " 物理机浏览器访问:  http://${IP}:${PORT}/"
echo "   - paseo-android-${VER}.apk"
echo "   - paseo-desktop-win-x64-${VER}.zip"
echo " 提前停服:  bash $(basename "$0") stop"
echo "============================================"
ss -ltnp 2>/dev/null | grep -q ":${PORT} " && echo " 正在监听 ${PORT}" || echo " ⚠️ 未检测到监听，看日志 $LOG"
