# Shared helpers for the pre-flight harness. Sourced by 0N_*.sh.
#
# Every pre-flight script is runnable WITHOUT a live meeting and prints a clear
# PASS/FAIL so meeting minutes are never spent debugging the harness itself.
#
# Override paths via env if your checkouts live elsewhere:
#   ZOOM_REPO=/path/to/meetingsdk-headless-linux-sample TRIAGE_BOT=/path/to/triage-bot ./preflight/01_build.sh

set -uo pipefail

ZOOM_REPO="${ZOOM_REPO:-/Users/dylanskinner/meetingsdk-headless-linux-sample}"
TRIAGE_BOT="${TRIAGE_BOT:-/Users/dylanskinner/triage-bot}"

pass() { echo "✅ PASS — $*"; exit 0; }
fail() { echo "❌ FAIL — $*"; exit 1; }
info() { echo "·  $*"; }
hr()   { echo "------------------------------------------------------------"; }
