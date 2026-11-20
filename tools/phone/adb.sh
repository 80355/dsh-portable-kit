#!/bin/bash
# 手机 ADB 封装：自动重连 + 重试，解决荣耀 60 Pro 反复掉线问题。
#
# 用法：
#   source tools/phone/adb.sh
#   P shell "dumpsys window | grep -i mCurrentFocus"
#   P exec-out screencap -p > /tmp/shot.png
#
# 设计要点（踩坑记录）：
# 1. 荣耀 60 Pro 的 ADB 会间歇性从 device 掉成空列表；
#    实测原因是连续快速发多条命令时 server 状态错乱，不是硬件/线材问题。
# 2. 恢复手段确定为 `adb kill-server; adb start-server`，单次即可恢复。
# 3. 每次调用都先探活，掉线则重启 server 再重试，最多 3 轮。

ADB_BIN="${ADB_BIN:-adb}"
PHONE_SERIAL="${PHONE_SERIAL:-}"

# 在自己机器上就 export PHONE_SERIAL=<你的序列号>；下面这行留空 = 用无线调试
PHONE_SERIAL=''
export PHONE_SERIAL

_adb_probe() {
  "$ADB_BIN" devices 2>/dev/null | grep -q "^${PHONE_SERIAL}[[:space:]]*device"
}

_adb_recover() {
  "$ADB_BIN" kill-server >/dev/null 2>&1
  sleep 1
  "$ADB_BIN" start-server >/dev/null 2>&1
  sleep 3
}

# P = phone adb，带回溯重连
P() {
  local attempt out rc
  for attempt in 1 2 3; do
    if _adb_probe; then
      out=$("$ADB_BIN" -s "$PHONE_SERIAL" "$@" 2>&1)
      rc=$?
      if ! printf '%s' "$out" | grep -q "device '${PHONE_SERIAL}' not found\|device not found\|no devices/emulators"; then
        printf '%s' "$out"
        return $rc
      fi
    fi
    _adb_recover
  done
  echo "ADB_UNRECOVERABLE after 3 attempts" >&2
  return 1
}

# Pshot <本地路径>：截图到本地，自动重连
Pshot() {
  local dest="${1:-/tmp/phone/shot.png}"
  mkdir -p "$(dirname "$dest")"
  local attempt
  for attempt in 1 2 3; do
    _adb_probe || { _adb_recover; continue; }
    if "$ADB_BIN" -s "$PHONE_SERIAL" exec-out screencap -p > "$dest" 2>/dev/null; then
      if [ -s "$dest" ]; then
        echo "$dest"
        return 0
      fi
    fi
    _adb_recover
  done
  echo "SCREENSHOT_FAILED" >&2
  return 1
}

# Pui：拿当前窗口的控件树 XML
Pui() {
  P shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  P shell cat /sdcard/ui.xml
}

# Pfocus：当前前台 Activity
Pfocus() {
  P shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'" | head -2
}

export -f _adb_probe _adb_recover P Pshot Pui Pfocus 2>/dev/null || true
