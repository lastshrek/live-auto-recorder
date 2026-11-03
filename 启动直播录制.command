#!/bin/bash
# 直播自动录制 — macOS 启动脚本
# 双击「启动直播录制.command」即可运行；关闭窗口 = 最小化到菜单栏托盘继续录制。
#
# 关于代理：本程序用 ffmpeg 拉流，ffmpeg 只认 HTTP_PROXY/HTTPS_PROXY 环境变量，
# 不读取 macOS 系统代理设置。下面按优先级决定用哪个代理：
#   1) 环境变量 LIVE_RECORDER_PROXY
#   2) 系统设置里已启用的 HTTP/HTTPS 代理（自动读取）
#   3) 都不满足则直连（清空所有代理变量，避免继承到失效代理）
PROXY="${LIVE_RECORDER_PROXY:-}"

# 读取 macOS 系统代理（scutil --proxy 输出形如 HTTPPort : 7897 / HTTPProxy : 127.0.0.1）
system_proxy() {
  local info port host
  info=$(scutil --proxy 2>/dev/null) || return 1
  port=$(printf '%s\n' "$info" | awk '/HTTPSPort :/ {print $3; exit} /HTTPPort :/ {print $3; exit}')
  host=$(printf '%s\n' "$info" | awk '/HTTPSProxy :/ {print $3; exit} /HTTPProxy :/ {print $3; exit}')
  [ -n "$host" ] && [ -n "$port" ] && printf 'http://%s:%s\n' "$host" "$port"
}

cd "$(dirname "$0")" || exit 1

APP="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$APP" ]; then
  echo ""
  echo "Electron 运行时缺失。请先执行："
  echo "  cd \"$(pwd)\" && npm install"
  echo ""
  read -r -n 1 -p "按任意键关闭..."
  exit 1
fi

mkdir -p logs
# 清掉可能残留的 GPU 崩溃回退标记，避免一直以软件渲染运行
rm -f logs/lifecycle/gpu-fallback.json

# 清掉继承来的失效代理（终端/沙箱注入的 127.0.0.1:51082 之类会让 ffmpeg 拉流直接 502）
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

[ -z "$PROXY" ] && PROXY=$(system_proxy)

if [ -n "$PROXY" ]; then
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
  echo "使用代理：$PROXY"
else
  echo "未检测到可用代理，直连拉流。"
fi

# env -u ELECTRON_RUN_AS_NODE：部分终端环境会注入该变量，导致 Electron 退化为 Node 而不开窗口
# --no-sandbox：受限权限环境下 Electron 沙箱初始化失败会导致界面空白
env -u ELECTRON_RUN_AS_NODE -u NODE_TLS_REJECT_UNAUTHORIZED \
  nohup "$APP" . --no-sandbox >> logs/launcher.out 2>&1 &

echo "直播自动录制已启动。"
echo "关闭窗口不会停止录制；退出请点菜单栏托盘图标 → 退出。"
sleep 2
exit 0