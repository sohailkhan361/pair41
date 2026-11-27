#!/usr/bin/env bash
# Local development: migrate the configured database and serve on http://localhost:8765.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PAIR41_DATABASE_URL:?Set PAIR41_DATABASE_URL to your Postgres connection URL}"
bin/pair41 migrate
exec bin/pair41 serve
