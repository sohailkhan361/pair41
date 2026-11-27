#!/usr/bin/env bash
# Quick metrics for the README: page load and send-to-receipt times on a local server.
set -euo pipefail
cd "$(dirname "$0")/.."
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
exec node scripts/bench.ts "$@"
