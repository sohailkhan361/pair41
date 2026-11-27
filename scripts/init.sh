#!/usr/bin/env bash
# Sets up a development environment: checks Node and installs dependencies from the lockfile.
set -euo pipefail
cd "$(dirname "$0")/.."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then
  echo "Pair41 needs Node 22.18 or newer (it runs TypeScript directly). Found $(node --version)." >&2
  exit 1
fi
[ "$node_major" -ne 22 ] && echo "Note: CI and the container use Node 22; you have $(node --version)."

npm ci
mkdir -p data
echo
echo "Set PAIR41_DATABASE_URL to your Postgres connection URL, then run scripts/dev.sh."
