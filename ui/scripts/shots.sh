#!/bin/sh
# Capture the map in the states worth checking before claiming it renders.
# Writes to ui/.shots/, which is ignored — these are evidence for one change,
# not artifacts to keep.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../.shots"
port=${VNODES_PORT:-7821}
base="http://127.0.0.1:$port/ui/map"
mkdir -p "$out"

if ! curl -sf "$base" >/dev/null; then
  echo "daemon not answering on $port — run: vnodes daemon start" >&2
  exit 1
fi

chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
[ -x "$chrome" ] || chrome=$(command -v google-chrome || command -v chromium || true)
[ -n "$chrome" ] || { echo "no chrome found — set CHROME=/path/to/chrome" >&2; exit 1; }

if ! curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  "$chrome" --headless=new --disable-gpu --no-sandbox \
    --remote-debugging-port=9222 --user-data-dir="$out/.chrome" about:blank \
    >"$out/.chrome.log" 2>&1 &
  sleep 3
fi

shoot() {
  echo "== $1"
  node "$here/shot.mjs" "$2" "$out/$1.png" "${3:-1600}" "${4:-1000}"
}

shoot whole   "$base"
shoot src     "$base?path=src"
shoot capsule "$base?task=wire%20a%20new%20agent%20into%20setup"
shoot narrow  "$base" 1100 800

echo "shots in $out"
