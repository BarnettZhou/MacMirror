#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# 保证虚拟屏后端已开启
if pgrep -x VirtualDisplay >/dev/null 2>&1; then
  echo "VirtualDisplay.app is already running"
else
  APP="${VIRTUAL_DISPLAY_APP:-/Applications/VirtualDisplay.app}"
  if [[ -d "$APP" ]]; then
    open -gj "$APP"
    echo "VirtualDisplay.app started"
  else
    echo "warning: VirtualDisplay.app not found at $APP; set VIRTUAL_DISPLAY_APP if installed elsewhere" >&2
  fi
fi

# 打开 node 服务（exec 让 node 接管进程，Ctrl+C 直接终止服务）
exec npm start
