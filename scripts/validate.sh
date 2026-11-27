#!/usr/bin/env bash
# Runs every check the CI pipeline runs. CI calls this same script.
set -euo pipefail
cd "$(dirname "$0")/.."

# Never let tests reach the Claude Code inbox socket of a session that runs this script.
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN

echo "== lint"
npx eslint .
echo "== format (check only)"
npx prettier --check .
echo "== type check"
npx tsc --noEmit
echo "== tests (SQLite)"
npx vitest run
if [ -n "${PAIR41_TEST_POSTGRES_URL:-}" ]; then
  echo "== tests (Postgres)"
  PAIR41_TEST_DATABASE=postgres npx vitest run
fi
echo "== static analysis"
if command -v semgrep >/dev/null 2>&1; then
  semgrep scan --config p/typescript --config p/javascript --config p/secrets --metrics=off --error --quiet \
    --exclude node_modules --exclude docs .
elif [ "${CI:-}" = "true" ]; then
  echo "semgrep is required in CI" >&2
  exit 1
else
  echo "WARN: semgrep is not installed, so static analysis was skipped locally. CI always runs it."
fi
echo "== all checks passed"
