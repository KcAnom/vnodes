#!/bin/sh
# update-vnodes — bring this clone of vnodes up to date in one command.
#
# Why this exists: vnodes is zero-dependency and ships its UI bundle
# committed, so "updating a machine" is a git pull plus two follow-ups that
# are easy to forget — running the tests, and restarting daemons that are
# still running yesterday's code (the staleness rule: a daemon answers with
# the code it loaded at boot). This script does the pull and the checks and
# NAMES the restarts; it never silently skips a stage.
#
# Usage:
#   sh scripts/update-vnodes.sh [flags]
#
# Flags:
#   --stash            stash local changes before pulling (pop is left to you)
#   --restart-daemons  stop running vnodes daemons after the update (the app
#                      itself must still be quit and reopened by hand)
#   --skip-tests       skip the unit-test floor (not recommended)
#   --help             this text
#
# Exit codes: 0 success (or already up to date), 1 something needs a human.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 1

STASH=0
RESTART=0
SKIP_TESTS=0

for arg in "$@"; do
  case "$arg" in
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    --stash) STASH=1 ;;
    --restart-daemons) RESTART=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "unknown flag: $arg (try --help)"; exit 1 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'update-vnodes: %s\n' "$*"; exit 1; }

# --- 1. this must be a git clone of vnodes --------------------------------
command -v git >/dev/null 2>&1 || fail "git not found on PATH"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "$REPO is not a git checkout — update by re-cloning instead"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
say "update-vnodes: $REPO (branch $BRANCH)"

# --- 2. node version floor -------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node not found on PATH (vnodes needs node >= 22.5)"
NODE_OK=$(node -p 'const [maj,min]=process.versions.node.split(".").map(Number); (maj>22||(maj===22&&min>=5))?"yes":"no"')
[ "$NODE_OK" = "yes" ] || fail "node $(node --version) is too old — vnodes needs >= 22.5"

# --- 3. local changes ------------------------------------------------------
# Tracked-file changes only: untracked files cannot block a fast-forward,
# and the check must not flag this very script sitting untracked in a
# fresh clone of an older revision.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  if [ "$STASH" = "1" ]; then
    say "local changes found — stashing (restore later with: git stash pop)"
    git stash push -m "update-vnodes auto-stash" >/dev/null || fail "could not stash local changes"
  else
    fail "local changes present — commit or stash them first, or re-run with --stash"
  fi
fi

# --- 4. pull (fast-forward only: no surprise merges on a tool clone) ------
git fetch origin >/dev/null 2>&1 || fail "could not reach origin — check the network"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$LOCAL")
if [ "$LOCAL" = "$REMOTE" ]; then
  say "already up to date at $(git rev-parse --short HEAD) — running checks anyway"
else
  AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
  [ "$AHEAD" != "0" ] && fail "this clone has $AHEAD unpushed commit(s) — push or rebase them first, do not let an update lose them"
  say "updating $(git rev-parse --short HEAD) -> $(echo "$REMOTE" | cut -c1-7)"
  git pull --ff-only || fail "fast-forward pull failed — resolve by hand (git status)"
fi

# --- 5. the unit-test floor -------------------------------------------------
if [ "$SKIP_TESTS" = "1" ]; then
  say "SKIPPING tests (--skip-tests) — this is not recommended"
else
  say "running the unit-test floor (npm test)…"
  npm test --silent >/tmp/update-vnodes-test.log 2>&1 \
    || { echo "tests FAILED — tail of the log:"; tail -20 /tmp/update-vnodes-test.log;
         fail "do not use this clone until tests pass (full log: /tmp/update-vnodes-test.log)"; }
  say "tests green"
fi

# --- 6. doctor (read-only, works regardless of daemons) --------------------
# One-line verdict, not the raw JSON: the update command should answer
# "is this clone healthy" in a sentence and name the failing check if not.
say "running doctor…"
node bin/vnodes.js doctor 2>/dev/null | node -e '
let b = "";
process.stdin.on("data", (c) => (b += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(b);
    const bad = j.checks.filter((c) => !c.ok);
    console.log(bad.length
      ? "UNHEALTHY — " + bad.map((c) => c.check + ": " + c.detail).join("; ")
      : "healthy (" + j.checks.length + " checks)");
  } catch {
    console.log("output unreadable — run: node bin/vnodes.js doctor");
  }
});' || say "doctor could not run — check node and the repo state"

# --- 7. running daemons: the staleness rule --------------------------------
DAEMONS=$(pgrep -f "vnodes.js daemon" 2>/dev/null || true)
if [ -n "$DAEMONS" ]; then
  say ""
  say "running vnodes daemon(s) — they are still on the OLD code until restarted:"
  for pid in $DAEMONS; do
    CWD=$(lsof -p "$pid" 2>/dev/null | awk '/cwd/ {for(i=9;i<=NF;i++) printf "%s ", $i; print ""}' | head -1)
    say "  pid $pid (cwd: ${CWD:-unknown})"
  done
  if [ "$RESTART" = "1" ]; then
    for pid in $DAEMONS; do kill "$pid" 2>/dev/null && say "  stopped pid $pid"; done
    say "daemons stopped — they auto-restart on the next tool call, on the new code."
  else
    say "stop them with:  vnodes daemon stop          (or re-run with --restart-daemons)"
  fi
  say "if the macOS app is open: quit and reopen it too (the WKWebView hub loads"
  say "code once at boot — same rule)."
else
  say "no daemons running — next tool call starts one on the new code."
fi

# --- 8. per-project reminder -------------------------------------------------
say ""
say "update complete. per-project follow-ups (not this clone's job):"
say "  cd <project> && vnodes hook install   # pre-commit keeps that index fresh"
say "  cd <project> && vnodes index          # only if the project was never indexed"
exit 0
