#!/usr/bin/env bash
# Builds the Claude Code plugin: the files in agent-kit/plugin/pair41 (manifest, MCP config, hooks, bin/pair41, the
# doctor skill) plus the agent-side CLI (Node built-ins only) and the pair41 skill.
#
#   scripts/build-plugin.sh            builds in place, for the local marketplace:
#                                        /plugin marketplace add <repo>/agent-kit/plugin
#                                        /plugin install pair41@pair41-local
#   scripts/build-plugin.sh <folder>   builds a full copy in <folder>, to publish to P41's plugin library. Use a folder
#                                      outside the repo: the built files are git-ignored here, and publishing leaves
#                                      git-ignored files out. Only the plugin's own entries in <folder> are replaced.
set -euo pipefail
cd "$(dirname "$0")/.."
src=agent-kit/plugin/pair41
out=${1:-$src}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
repo=$(pwd -P)
if [ "$out" != "$repo/$src" ]; then
  case "$out/" in
    "$repo"/*)
      echo "Build into a folder outside the repo, not $out." >&2
      exit 1
      ;;
  esac
  rm -rf "$out/.claude-plugin" "$out/.mcp.json" "$out/hooks" "$out/bin" "$out/skills"
  mkdir -p "$out/skills"
  cp -R "$src/.claude-plugin" "$src/.mcp.json" "$src/hooks" "$src/bin" "$out/"
  cp -R "$src/skills/doctor" "$out/skills/"
fi
rm -rf "$out/lib" "$out/skills/pair41"
mkdir -p "$out/lib/cli" "$out/skills/pair41"
for file in main.ts hooks.ts local.ts doctor.ts bridge.ts run.ts wait.ts; do
  cp "src/cli/$file" "$out/lib/cli/$file"
done
cp agent-kit/skills/pair41/SKILL.md "$out/skills/pair41/SKILL.md"
# Server commands (serve, migrate, admin) and install are not in the plugin.
echo "Built the Pair41 plugin in $out."
