#!/usr/bin/env bash
# dsh-remote —— 开发同步脚本（桌面版 Harness 专用）
#
# 零构建插件：宿主半 lib/index.js 由 cordis Loader 直接加载，
# 浏览器半 lib/client.js 由 dsh-client-modules 直接提供。
# 编辑源码后把 lib/（+ 补丁/清单）同步到 DSH 实际加载的安装目录即可生效。
#
# 用法：
#   ./sync.sh                    # 同步到桌面版 web profile（默认）
#   TARGET=cli ./sync.sh         # 同步到独立 CLI 的 web profile（~/.dsh/profiles/web）
#   PROFILE=xxx ./sync.sh        # 指定其他 profile 名
#
# ⚠️ 重要（v0.6.5 起）：这是**部署到产品**的脚本，日常迭代请勿直接用。
#   产品 profile 的 package.json 把 dsh-remote 声明为 `^0.5.10`，任何
#   npm / dsh plugin 重装都会把这里手工同步的文件覆盖回发行版
#   （v0.6.4 曾被重装回 0.5.10 顶掉的实证）。日常开发请用沙箱：
#     scripts/dev-run.sh          # 开发/沙箱模式，改源码即加载，不碰产品
#   sync.sh 仅用于**用户确认后**的受控发布。
#
# 生效方式：
#   - 宿主半（index.js）：需重启 DSH 进程（桌面版 = 重启 DSH Desktop 应用）
#   - 浏览器半（client.js）：页面刷新即可（无需重新构建）
set -euo pipefail

PROFILE="${PROFILE:-web}"
MODE="${TARGET:-desktop}"

case "$MODE" in
  desktop)
    BASE_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
    ;;
  cli)
    BASE_HOME="$HOME/.dsh"
    ;;
  *)
    echo "❌ 未知 TARGET: $MODE（可用 desktop | cli）" >&2
    exit 1
    ;;
esac

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$BASE_HOME/profiles/$PROFILE/node_modules/dsh-remote"

# ── 部署前静态闸门：违反框架约束（如命令名带点号）会搞崩整个桌面 ──
if [ -f "$SRC_DIR/check.mjs" ]; then
  echo "⏱  部署前检查 check.mjs …"
  node "$SRC_DIR/check.mjs" || { echo "❌ 静态检查未通过，中止部署（参考 scripts/dev-standards.md）。" >&2; exit 1; }
fi

if [ ! -d "$INSTALL_DIR" ]; then
  echo "❌ 未找到 profile 安装目录: $INSTALL_DIR"
  echo "   请先执行（在桌面版内）: dsh plugin --profile $PROFILE add dsh-remote"
  exit 1
fi

echo "同步 $SRC_DIR/lib → $INSTALL_DIR/lib"
cp -v "$SRC_DIR"/lib/*.js "$INSTALL_DIR/lib/"

# 顺带同步 cordis 补丁与包清单（幂等）
for f in cordis.patch.yml package.json; do
  if [ -f "$SRC_DIR/$f" ]; then
    cp "$SRC_DIR/$f" "$INSTALL_DIR/$f"
  fi
done

# ── 部署后自检（防止"自己把自己搞崩"）──────────────────────────────
# 1) 部署副本与源码逐字节一致
if ! diff -rq "$SRC_DIR/lib" "$INSTALL_DIR/lib" >/dev/null; then
  echo "❌ 自检失败：lib 未与源码一致（可能 cp 被中断）" >&2
  exit 1
fi
if ! diff -q "$SRC_DIR/package.json" "$INSTALL_DIR/package.json" >/dev/null 2>&1; then
  echo "⚠️  提示：package.json 与源码不一致（未随包清单同步？）"
fi
# 2) 启动冒烟测试（隔离 DSH_HOME，验证插件树能加载，不再把桌面搞崩）
if [ -x "$SRC_DIR/scripts/boot-smoke.sh" ] && [ "${SKIP_SMOKE:-0}" != "1" ]; then
  "$SRC_DIR/scripts/boot-smoke.sh" || { echo "❌ 启动冒烟失败，已停止部署交付。可用 SKIP_SMOKE=1 跳过（不推荐）。" >&2; exit 1; }
fi

echo ""
echo "✅ 已同步 → $INSTALL_DIR"
echo "   - 宿主半（index.js）改动：重启 DSH Desktop 生效"
echo "   - 浏览器半（client.js）改动：刷新页面生效"
