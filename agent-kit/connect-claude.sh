#!/usr/bin/env bash
# Connects Claude Code in one repo folder to Pair41: .pair41.json, the MCP server ("pair"), the hooks
# (.claude/settings.local.json) and the pair41 skill (.claude/skills/pair41).
#
# Usage: PAIR41_TOKEN=p41_... agent-kit/connect-claude.sh [--server URL] [--project NAME] [--with-bridge] [FOLDER]
#   FOLDER       the repo folder Claude Code runs in (default: the current folder)
#   --server     the Pair41 server (default: http://localhost:8765)
#   --project    the project name, the same for both people (default: the repo folder's name)
#   --with-bridge  also start the Pair41 bridge, which pushes partner messages into the session (only once P41 agrees)
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd -P)"
PAIR41="$(cd "$KIT/.." && pwd -P)/bin/pair41"
server="http://localhost:8765"
project=""
bridge=false
folder="."
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --with-bridge) bridge=true; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) folder="$1"; shift ;;
  esac
done
folder="$(cd "$folder" && pwd -P)"
[ -n "$project" ] || project="$(basename "$(git -C "$folder" rev-parse --show-toplevel 2>/dev/null || echo "$folder")")"
if [ -z "${PAIR41_TOKEN:-}" ]; then
  echo "Set PAIR41_TOKEN first: log in at $server, open 'Connect your agent', and export the token in your shell profile." >&2
  exit 1
fi
command -v claude >/dev/null || { echo "The claude command is not on PATH." >&2; exit 1; }

echo "Connecting Claude Code in $folder to $server (project $project)"

# 1. .pair41.json: where the server is and which project this folder belongs to.
node -e '
  const [file, server, project, bridge] = process.argv.slice(1);
  const config = { server, project };
  if (bridge === "true") config.bridge = true;
  require("node:fs").writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$folder/.pair41.json" "$server" "$project" "$bridge"

# 2. The MCP server, in Claude Code's local scope for this folder (your user config, not the repo).
(cd "$folder" && claude mcp remove pair -s local >/dev/null 2>&1 || true)
(cd "$folder" && claude mcp add --transport http pair "$server/mcp" -s local \
  --header "Authorization: Bearer ${PAIR41_TOKEN}" \
  --header "X-Pair-Agent: claude-code" --header "X-Pair-Project: $project")

# 3. Hooks, merged into .claude/settings.local.json (other settings and hooks are kept).
mkdir -p "$folder/.claude"
node -e '
  const fs = require("node:fs");
  const [file, pair41, bridge] = process.argv.slice(1);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const hook = (event, extra = {}) => ({ type: "command", command: `"${pair41}" hook ${event} --agent claude-code`, ...extra });
  const ours = {
    SessionStart: [{ hooks: [hook("session-start"), ...(bridge === "true" ? [{ type: "command", async: true, command: `"${pair41}" bridge` }] : [])] }],
    UserPromptSubmit: [{ hooks: [hook("user-prompt-submit")] }],
    PreToolUse: [{ matcher: "mcp__.*pair__.*", hooks: [hook("pre-tool-use")] }],
    PostToolUse: [{ hooks: [hook("post-tool-use")] }],
    Stop: [{ hooks: [hook("stop"), { type: "command", command: `"${pair41}" wait --agent claude-code`, asyncRewake: true, timeout: 29100 }] }],
    SessionEnd: [{ hooks: [hook("session-end")] }],
  };
  settings.hooks = settings.hooks || {};
  for (const [event, groups] of Object.entries(ours)) {
    const others = (settings.hooks[event] || []).filter((g) => !JSON.stringify(g).includes("pair41"));
    settings.hooks[event] = [...others, ...groups];
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
' "$folder/.claude/settings.local.json" "$PAIR41" "$bridge"

# 4. The pair41 skill.
mkdir -p "$folder/.claude/skills/pair41"
cp "$KIT/skills/pair41/SKILL.md" "$folder/.claude/skills/pair41/SKILL.md"

echo
echo "Done. Next:"
echo "  1. Start Claude Code in $folder and run /mcp: 'pair' should be connected."
echo "  2. Run: $PAIR41 doctor --agent claude-code   (from $folder)"
[ "$bridge" = true ] && echo "  3. The bridge is on: run '! $PAIR41 doctor --agent claude-code' inside Claude Code to check the inbox socket."
exit 0
