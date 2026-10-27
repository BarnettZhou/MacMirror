#!/bin/bash
# Mac Mirror 初始化：检查开发环境 + 安装项目依赖
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "error: $1" >&2; exit 1; }

echo "==> 检查开发环境"

# macOS 13+
[[ "$(uname -s)" == "Darwin" ]] || fail "仅支持 macOS"
macos_major="$(sw_vers -productVersion | cut -d. -f1)"
[[ "$macos_major" -ge 13 ]] || fail "需要 macOS 13 或更高版本，当前 $(sw_vers -productVersion)"

# Node.js 20+
command -v node >/dev/null 2>&1 || fail "未找到 node，请先安装 Node.js 20+（https://nodejs.org 或 brew install node）"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 20 ]] || fail "需要 Node.js 20+，当前 $(node -v)"

# Swift 6 工具链
command -v swift >/dev/null 2>&1 || fail "未找到 swift，请安装 Xcode 16+ 或 Xcode Command Line Tools"
swift_major="$(swift --version 2>/dev/null | sed -n 's/.*Swift version \([0-9]*\).*/\1/p' | head -1)"
[[ -n "$swift_major" && "$swift_major" -ge 6 ]] || fail "需要 Swift 6 工具链，当前：$(swift --version 2>/dev/null | head -1)"

# VirtualDisplay.app（含 vdctl）
VDCTL_CANDIDATES=(
  "${VIRTUAL_DISPLAY_CTL:-}"
  "/Applications/VirtualDisplay.app/Contents/MacOS/vdctl"
  "/tmp/VirtualDisplay-derived-app/Build/Products/Debug/VirtualDisplay.app/Contents/MacOS/vdctl"
)
find_vdctl() {
  vdctl_found=""
  for c in "${VDCTL_CANDIDATES[@]}"; do
    [[ -n "$c" && -x "$c" ]] && vdctl_found="$c" && break
  done
}
install_virtualdisplay() {
  echo "    查询 VirtualDisplay 最新 release…"
  local url
  url="$(curl -fsSL https://api.github.com/repos/youngyunxing/VirtualDisplay/releases/latest \
    | sed -n 's/.*"browser_download_url": *"\([^"]*\.zip\)".*/\1/p' | head -1)" \
    || fail "无法访问 GitHub API，请手动安装：https://github.com/youngyunxing/VirtualDisplay"
  [[ -n "$url" ]] || fail "release 中未找到 zip 资产，请手动安装：https://github.com/youngyunxing/VirtualDisplay/releases"
  local tmp
  tmp="$(mktemp -d)"
  echo "    下载 $url"
  if ! curl -fSL "$url" -o "$tmp/VirtualDisplay.zip"; then
    rm -rf "$tmp"; fail "下载失败，请检查网络后重试或手动安装"
  fi
  if ! ditto -x -k "$tmp/VirtualDisplay.zip" "$tmp/app"; then
    rm -rf "$tmp"; fail "解压失败，请手动安装"
  fi
  local app
  app="$(find "$tmp/app" -maxdepth 2 -name 'VirtualDisplay.app' | head -1)"
  if [[ -z "$app" ]]; then
    rm -rf "$tmp"; fail "压缩包中未找到 VirtualDisplay.app，请手动安装"
  fi
  if ! ditto "$app" /Applications/VirtualDisplay.app; then
    rm -rf "$tmp"; fail "无法写入 /Applications，请手动把 VirtualDisplay.app 拖入「应用程序」文件夹"
  fi
  rm -rf "$tmp"
  xattr -dr com.apple.quarantine /Applications/VirtualDisplay.app 2>/dev/null || true
  echo "    VirtualDisplay 已安装到 /Applications/VirtualDisplay.app（已移除隔离属性）"
}
find_vdctl
if [[ -z "$vdctl_found" ]]; then
  echo "    未检测到 VirtualDisplay"
  reply="n"
  if [[ -e /dev/tty ]]; then
    printf "    是否现在从 GitHub 下载安装最新版 VirtualDisplay？[Y/n] "
    read -r reply < /dev/tty || reply="n"
  fi
  case "$reply" in
    ""|y|Y|yes|YES|Yes) install_virtualdisplay ;;
    *) echo "    warning: 跳过 VirtualDisplay 安装。它是必需组件，请自行按 README 的「安装 VirtualDisplay」一节安装，否则服务无法工作。" >&2 ;;
  esac
  find_vdctl
  if [[ -z "$vdctl_found" ]]; then
    echo "    warning: 未找到 vdctl，start.sh 启动后虚拟屏将不可用，请先完成 VirtualDisplay 安装。" >&2
  fi
fi
summary="    macOS $(sw_vers -productVersion) / node $(node -v) / $(swift --version 2>/dev/null | head -1 | sed 's/^.*Swift version/Swift/')"
[[ -n "$vdctl_found" ]] && summary="$summary / vdctl: $vdctl_found"
echo "$summary"

echo "==> 检查项目依赖"

# node_modules
if [[ -d node_modules/ws ]]; then
  echo "    node_modules 已就位，跳过 npm install"
else
  echo "    安装 npm 依赖…"
  npm install
fi

# Swift 辅助程序（MirrorCapture / MirrorDisplayCtl）
if [[ -x .build/debug/MirrorCapture && -x .build/debug/MirrorDisplayCtl ]]; then
  echo "    Swift 辅助程序已就位，跳过 swift build"
else
  echo "    构建 Swift 辅助程序…"
  swift build
fi

echo ""
echo "初始化完成。运行 ./start.sh 启动服务。"
