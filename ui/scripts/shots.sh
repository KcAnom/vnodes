#!/bin/sh
# Capture every page in the states worth checking before claiming they render.
#
# There are five of them now rather than one, and the map's four states are
# still the ones most likely to be wrong — but a shell with a rail on it can
# break every page at once, so the whole surface is shot.
# Writes to ui/.shots/, which is ignored — these are evidence for one change,
# not artifacts to keep.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../.shots"
port=${VNODES_PORT:-7821}
base="http://127.0.0.1:$port/ui"
mkdir -p "$out"

if ! curl -sf "$base/map" >/dev/null; then
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

# The map, in the four states its layout has to survive.
shoot map-whole    "$base/map"
shoot map-src      "$base/map?path=src"
shoot map-task     "$base/map?task=wire%20a%20new%20agent%20into%20setup"
shoot map-roomy    "$base/map?compact=0"

# The four document pages.
shoot overview     "$base"
shoot capsule      "$base/capsule?task=wire%20a%20new%20agent%20into%20setup"
shoot capsule-empty "$base/capsule"
shoot notes        "$base/notes"
shoot notes-search "$base/notes?q=map"
shoot index        "$base/index"

# A page that does not exist, because the catch-all used to answer 200 for it.
shoot missing      "$base/nope"

# Narrow. 960 rather than 1100 because the rail collapses at 1024 and a 1100px
# shot proves nothing about it — the first version of this check was 1100 and
# photographed the wide rail twice.
shoot narrow-overview "$base" 960 800
shoot narrow-map      "$base/map" 960 800

echo "shots in $out"
