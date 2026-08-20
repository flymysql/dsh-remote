#!/usr/bin/env bash
# dsh-remote —— 开发/沙箱模式（默认迭代方式）
#
# 为什么需要沙箱：产品 profile（DSH Desktop）里的 dsh-remote 声明为
# `^0.5.10`，任何 npm / dsh plugin 重装都会把手工部署的文件覆盖回发行版
# （v0.6.4 曾被重装回 0.5.10 顶掉的实证）。所以日常开发**禁止直接改产品
# profile**，一律在本沙箱里迭代：
#
#   · 隔离 DSH_HOME（dev-harness/harness）—— 数据、profile、session 全独立，
#     绝不碰产品 DSH_HOME。
#   · profile 用硬链接拷贝产品 profile（快、省空间），再把已装的
#     node_modules/dsh-remote/lib 覆盖为**源码 lib/ 的拷贝**——每次启动都会
#     重新覆盖，改源码 → 重启沙箱即生效。
#     （为什么不用 symlink：Node ESM 依赖按 realpath 解析，symlink 会把
#     @deepseek-ai/schemastery 等解析到仓库根目录去，直接加载失败。
#     拷贝才能让依赖沿 profiles/web/node_modules 解析，与产品环境一致。）
#   · 从产品拷入 machines.json / known_hosts.json（首次）—— 沙箱里能看到
#     你的真实机器，但增删改只写沙箱副本。
#   · 用桌面自带 harness 起一个独立端口实例（默认 50599），浏览器打开即用。
#
# 用法：
#   scripts/dev-run.sh                 # 启动沙箱（profile 缺失时自动创建，并覆盖最新 lib/）
#   scripts/dev-run.sh --restart       # 重启（宿主半改动后用这个；会自动覆盖最新 lib/）
#   scripts/dev-run.sh --refresh       # 重建 profile（重新从产品拷）+ 启动
#   scripts/dev-run.sh --port 50888    # 自定义端口
#   scripts/dev-run.sh --stop          # 停止沙箱实例
#   scripts/dev-run.sh --status        # 查看运行状态
#
# 生效方式：宿主半（index.js）改动 → --restart；浏览器半（client.js）改动 →
# --restart 后刷新页面（页面刷新本身只对 client 半；host 半必须重启沙箱）。
set -euo pipefail

APP="/Users/4FMTWRV/Downloads/dsh-desktop/dist/mac-arm64/DSH Desktop.app/Contents/Resources"
PROD_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$WORKSPACE"
DEV_ROOT="$WORKSPACE/dev-harness"
DEV_HOME="${DEV_HOME:-$DEV_ROOT/harness}"
PORT="${DEV_PORT:-50599}"
PROFILE="${PROFILE:-web}"
LOG="$DEV_ROOT/dev.log"
PIDFILE="$DEV_ROOT/dev.pid"

ACTION=start
while [ $# -gt 0 ]; do
  case "$1" in
    --refresh) ACTION=refresh ;;
    --restart) ACTION=restart ;;
    --stop)    ACTION=stop ;;
    --status)  ACTION=status ;;
    --port)    PORT="$2"; shift 2; continue ;;
    *)         echo "⚠️  忽略未知参数: $1" ;;
  esac
  shift
done

NODE="$APP/app/node_modules/node/bin/node"
BIN="$APP/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
PATCH="$APP/dsh-desktop.patch.yml"
PROFILE_DIR="$DEV_HOME/profiles/$PROFILE"
INSTALL_DIR="$PROFILE_DIR/node_modules/dsh-remote"

require_app() {
  if [ ! -f "$BIN" ]; then
    echo "❌ 未找到桌面版 harness 入口: $BIN" >&2
    echo "   若 DSH Desktop 路径变化，请修改本脚本顶部 APP 常量。" >&2
    exit 1
  fi
  if [ ! -f "$PATCH" ]; then
    echo "❌ 未找到桌面补丁: $PATCH" >&2
    exit 1
  fi
}

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || echo '')"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

do_stop() {
  if is_running; then
    local pid; pid="$(cat "$PIDFILE")"
    echo "⏹  停止沙箱实例 (pid $pid, port $PORT) …"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "✅ 已停止。"
  else
    rm -f "$PIDFILE"
    echo "ℹ️  沙箱未在运行。"
  fi
}

# 覆盖已装 dsh-remote/lib 为源码最新拷贝（连同清单/补丁）
# 注意：写入前先 unlink（rm -f），绝不允许通过硬链接就地覆写产品文件
# （cp -al 之后写入会顺着硬链接改到产品——v0.6.5 开发时真踩过）。
sync_lib() {
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/lib"
  rm -f "$INSTALL_DIR/package.json" "$INSTALL_DIR/cordis.patch.yml" "$INSTALL_DIR/LICENSE"
  cp -r "$SRC/lib" "$INSTALL_DIR/lib"
  cp "$SRC/package.json" "$INSTALL_DIR/package.json"
  cp "$SRC/cordis.patch.yml" "$INSTALL_DIR/cordis.patch.yml"
  echo "   lib/ 已覆盖为源码最新（$(grep '"version"' "$SRC/package.json" | head -1 | tr -d ' ",' )）"
}

build_profile() {
  echo "⏱  创建沙箱 profile（硬链接拷贝产品 profile）…"
  mkdir -p "$DEV_HOME/profiles"
  if [ ! -d "$PROD_HOME/profiles/$PROFILE" ]; then
    echo "❌ 产品 profile 不存在: $PROD_HOME/profiles/$PROFILE" >&2
    exit 1
  fi
  if [ -d "$PROFILE_DIR" ]; then rm -rf "$PROFILE_DIR"; fi
  if ! cp -al "$PROD_HOME/profiles/$PROFILE" "$PROFILE_DIR" 2>/dev/null; then
    cp -a "$PROD_HOME/profiles/$PROFILE" "$PROFILE_DIR"
  fi
  # 彻底解耦 dsh-remote：删掉硬链接目录，重建为独立目录再放源码拷贝，
  # 这样后续 sync_lib 的所有写入都不会碰到产品文件。
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  sync_lib
  # 守卫：确认沙箱 manifest 与产品不再是同一 inode（防硬链接写入）
  local prod_pkg="$PROD_HOME/profiles/$PROFILE/node_modules/dsh-remote/package.json"
  if [ -f "$prod_pkg" ]; then
    local a b
    a="$(stat -f %i "$INSTALL_DIR/package.json")"
    b="$(stat -f %i "$prod_pkg")"
    if [ "$a" = "$b" ]; then
      echo "❌ 守卫失败：沙箱与产品 dsh-remote/package.json 同 inode，中止。" >&2
      exit 1
    fi
  fi
  # 数据种子：machines / known_hosts 从产品拷入（只读源，沙箱独立写）
  mkdir -p "$DEV_HOME/remote-workspaces"
  for f in machines.json known_hosts.json; do
    if [ ! -f "$DEV_HOME/remote-workspaces/$f" ] && [ -f "$PROD_HOME/remote-workspaces/$f" ]; then
      cp "$PROD_HOME/remote-workspaces/$f" "$DEV_HOME/remote-workspaces/$f"
      echo "   已种子数据 remote-workspaces/$f"
    fi
  done
}

do_start() {
  require_app
  if is_running; then
    echo "✅ 沙箱已在运行: http://127.0.0.1:$PORT  (pid $(cat "$PIDFILE"))"
    echo "   重启用: scripts/dev-run.sh --restart"
    return 0
  fi
  if [ ! -d "$PROFILE_DIR" ]; then
    build_profile
  else
    sync_lib
  fi
  echo "⏱  启动隔离 harness（port $PORT, DSH_HOME=$DEV_HOME）…"
  mkdir -p "$DEV_ROOT"
  DSH_HOME="$DEV_HOME" "$NODE" --expose-internals \
    "$BIN" web --patch "$PATCH" --host 127.0.0.1 --port "$PORT" \
    >"$LOG" 2>&1 &
  echo "$!" > "$PIDFILE"
  local ok=0
  for _ in $(seq 1 40); do
    if grep -q "DSH entry failed" "$LOG"; then break; fi
    if grep -q "dsh web: http" "$LOG"; then ok=1; break; fi
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ "$ok" != 1 ]; then
    echo "❌ 沙箱启动失败（插件树加载出错）：" >&2
    tail -30 "$LOG" >&2 || true
    exit 1
  fi
  echo "✅ 沙箱就绪: http://127.0.0.1:$PORT"
  echo "   · 日志: $LOG"
  echo "   · 停止: scripts/dev-run.sh --stop"
  # 探针：验证插件 JSON 路由真的注册上了（不是只看健康行）
  sleep 1
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dsh-remote/machines" 2>/dev/null || echo '000')"
  echo "   · 插件路由 /dsh-remote/machines → HTTP $code（200/404 均为插件已加载，401 需在页面内访问）"
}

case "$ACTION" in
  stop)    do_stop ;;
  status)
    if is_running; then echo "🟢 运行中: http://127.0.0.1:$PORT (pid $(cat "$PIDFILE"))"; else echo "⚪ 未运行"; fi
    ;;
  refresh) do_stop; build_profile; do_start ;;
  restart) do_stop; do_start ;;
  start)   do_start ;;
esac
