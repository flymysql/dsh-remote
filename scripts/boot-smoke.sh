#!/usr/bin/env bash
# 启动冒烟测试（Boot smoke test）—— dsh-remote 部署后必跑
#
# 背景：v0.6.1 曾因命令名 `remote.forget-key` 违反 dsh-commands 约束
# （/^[a-z][a-z0-9_-]*$/u）导致插件树加载失败、整个 DSH Desktop 无法启动。
# 从那以后，任何"宿主半"改动部署后都必须跑本脚本验证插件树能加载。
#
# 做法：在隔离的临时 DSH_HOME 里硬链接拷贝 web profile（快、不占额外空间），
# 用桌面自带 harness 起一个临时端口的实例，等它打出 "dsh web:"（健康）或
# "DSH entry failed"（失败），然后杀掉并清理。
#
# 用法：
#   scripts/boot-smoke.sh            # 测桌面版 web profile（默认）
#   PROFILE=xxx scripts/boot-smoke.sh
set -euo pipefail

APP="/Users/4FMTWRV/Downloads/dsh-desktop/dist/mac-arm64/DSH Desktop.app/Contents/Resources"
SRC_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
PROFILE="${PROFILE:-web}"
PORT="${SMOKE_PORT:-53199}"

if [ ! -f "$APP/app/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "❌ 未找到桌面版 harness 入口: $APP/app/node_modules/@deepseek-ai/dsh/lib/bin.js" >&2
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "⏱  准备隔离 profile（硬链接拷贝，免复制大体积 node_modules）…"
mkdir -p "$TMP/harness/profiles"
if ! cp -al "$SRC_HOME/profiles/$PROFILE" "$TMP/harness/profiles/$PROFILE" 2>/dev/null; then
  cp -a "$SRC_HOME/profiles/$PROFILE" "$TMP/harness/profiles/$PROFILE"
fi

LOG="$TMP/boot.log"
echo "⏱  启动隔离 harness（port $PORT）…"
DSH_HOME="$TMP/harness" "$APP/app/node_modules/node/bin/node" --expose-internals \
  "$APP/app/node_modules/@deepseek-ai/dsh/lib/bin.js" web \
  --patch "$APP/dsh-desktop.patch.yml" --host 127.0.0.1 --port "$PORT" \
  >"$LOG" 2>&1 &
PID=$!

ok=0
for _ in $(seq 1 40); do
  if grep -q "DSH entry failed" "$LOG"; then break; fi
  if grep -q "dsh web: http" "$LOG"; then ok=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ "$ok" = 1 ]; then
  echo "✅ 启动冒烟通过：插件树加载成功，harness 已在 :$PORT 起服务"
  kill "$PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PID" 2>/dev/null || true
  exit 0
fi

echo "❌ 启动冒烟失败（插件树加载出错）："
tail -25 "$LOG" || true
exit 1
