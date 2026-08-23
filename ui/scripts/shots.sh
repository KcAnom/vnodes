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

# The picker, which is now the app's landing page — the state most likely to be
# wrong and least likely to be looked at twice. `bases` and the bare `$base`
# shot above are the same component; both are kept because they are two URLs a
# reader arrives on and only one of them is the one anybody types.
shoot bases        "$base/bases"
shoot bases-narrow "$base/bases" 960 800

# A page scoped to a knowledge base that is not the launch project, resolved out
# of the registry rather than hard-coded, because the ids are per-machine.
# Parsed with node rather than sed: the daemon minifies its JSON onto one line
# and a greedy `.*"id"` would take the last entry, not the first.
kb=$(curl -s "$base/api/kbs" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const j=JSON.parse(b);process.stdout.write((j.kbs||[]).map(r=>r.id).find(id=>/^[0-9a-f]{16}$/.test(id))||"")}catch{}})')
if [ -n "$kb" ]; then
  shoot kb-scoped  "$base?kb=$kb"
else
  echo "== kb-scoped skipped: /ui/api/kbs listed no knowledge base" >&2
fi

# A kb id that resolves to nothing — what a link from another machine looks
# like. It must say so and must not draw a graph.
shoot bad-kb       "$base/map?kb=0000000000000000"

# A page that does not exist, because the catch-all used to answer 200 for it.
shoot missing      "$base/nope"

# Narrow. 960 rather than 1100 because the rail collapses at 1024 and a 1100px
# shot proves nothing about it — the first version of this check was 1100 and
# photographed the wide rail twice.
shoot narrow-overview "$base" 960 800
shoot narrow-map      "$base/map" 960 800

echo "shots in $out"
