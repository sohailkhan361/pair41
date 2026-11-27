---
name: doctor
description: Checks this machine's Pair41 setup for Claude Code (the plugin, the server, the agent token, the hooks) and says how to fix what is wrong. Use when the person asks to check Pair41, or when the Pair41 tools or hooks fail.
---

# Pair41 doctor

1. Run the plugin's own check. It only reads; it changes no config.

   ```bash
   CLAUDE_PLUGIN_OPTION_SERVER='${user_config.server}' "${CLAUDE_SKILL_DIR}/../../bin/pair41" doctor --agent claude-code
   ```

2. The plugin keeps the agent token in Claude Code, where that check cannot read it. Check the token by calling the Pair41 `pair_status` tool: if it answers, the token works. If it fails as unauthorized, the token is wrong or was regenerated: the person gets a new one on the Pair41 page ("Connect your agent") and enters it with `/plugin manage`.

3. Tell the person what passed and what failed, with the fix for each problem. Do not change any config yourself.
