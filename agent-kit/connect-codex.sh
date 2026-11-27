#!/usr/bin/env bash
# Connects Codex in one repo folder to Pair41: .pair41.json, the MCP server ("pair") in .codex/config.toml, the hooks
# in .codex/hooks.json and the pair41 skill. Codex reads a project's .codex/ only once you trust the project, and the
# hooks only after you trust them with /hooks.
#
# Usage: PAIR41_TOKEN=p41_... agent-kit/connect-codex.sh [--server URL] [--project NAME] [FOLDER]
#   FOLDER     the repo folder Codex runs in (default: the current folder)
#   --server   the Pair41 server (default: http://localhost:8765)
#   --project  the project name, the same for both people (default: the repo folder's name)
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd -P)"
PAIR41="$(cd "$KIT/.." && pwd -P)/bin/pair41"
server="http://localhost:8765"
project=""
folder="."
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
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

echo "Connecting Codex in $folder to $server (project $project)"

# 1. .pair41.json
node -e '
  const [file, server, project] = process.argv.slice(1);
  require("node:fs").writeFileSync(file, JSON.stringify({ server, project }, null, 2) + "\n");
' "$folder/.pair41.json" "$server" "$project"

# 2. The MCP server. The token stays in the PAIR41_TOKEN environment variable, never in the file.
mkdir -p "$folder/.codex"
config="$folder/.codex/config.toml"
if [ -f "$config" ] && grep -q '^\[mcp_servers\.pair\]' "$config"; then
  echo "  $config already has [mcp_servers.pair]; left as it is."
else
  cat >> "$config" <<TOML

[mcp_servers.pair]
url = "$server/mcp"
bearer_token_env_var = "PAIR41_TOKEN"
http_headers = { "X-Pair-Agent" = "codex", "X-Pair-Project" = "$project" }
# Pair41 tools run without a prompt each time (QUESTIONS.md 45); without this, codex exec refuses them.
default_tools_approval_mode = "approve"
TOML
fi

# 3. Hooks, merged into .codex/hooks.json (other hooks are kept).
node -e '
  const fs = require("node:fs");
  const [file, pair41] = process.argv.slice(1);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const hook = (event) => ({ hooks: [{ type: "command", command: `"${pair41}" hook ${event} --agent codex` }] });
  const ours = {
    SessionStart: [hook("session-start")],
    UserPromptSubmit: [hook("user-prompt-submit")],
    PreToolUse: [hook("pre-tool-use")],
    PostToolUse: [hook("post-tool-use")],
    Stop: [hook("stop")],
  };
  settings.hooks = settings.hooks || {};
  for (const [event, groups] of Object.entries(ours)) {
    const others = (settings.hooks[event] || []).filter((g) => !JSON.stringify(g).includes("pair41"));
    settings.hooks[event] = [...others, ...groups];
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
' "$folder/.codex/hooks.json" "$PAIR41"

# 4. The pair41 skill, in both places Codex may read project skills from.
for dir in "$folder/.agents/skills/pair41" "$folder/.codex/skills/pair41"; do
  mkdir -p "$dir"
  cp "$KIT/skills/pair41/SKILL.md" "$dir/SKILL.md"
done

echo
echo "Done. Next:"
echo "  1. Start Codex in $folder and trust the project when it asks."
echo "  2. In Codex, run /hooks and trust the Pair41 hooks (once)."
echo "  3. Run: $PAIR41 doctor --agent codex   (from $folder)"
