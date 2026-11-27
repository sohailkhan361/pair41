// pair41 hook <event>: run by Claude Code and Codex. Reads the hook's JSON on stdin, prints only the hook's JSON
// result on stdout, logs to $PAIR41_HOME/hooks.log, and always exits 0 so it never breaks the agent.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agentKind, loadLocalConfig, log, pidFile, postJson, readStdin, stopByPidFile } from './local.ts';

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  model?: unknown;
}

const EVENT_NAMES: Record<string, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'session-end': 'SessionEnd',
};

/** Pair41's own MCP tools: server "pair", directly or inside the pair41 plugin. */
export function isPairTool(toolName: string | undefined): boolean {
  return !!toolName && /^mcp__(?:plugin_pair41_)?pair__/.test(toolName);
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

/** Files an edit tool touched, relative to the repo root: Claude Code's Edit/Write/MultiEdit/NotebookEdit, Codex's apply_patch. */
function filesTouched(input: HookInput, cwd: string): string[] {
  const toolInput = input.tool_input ?? {};
  const paths: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = toolInput[key];
    if (typeof value === 'string' && /edit|write|patch/i.test(input.tool_name ?? '')) paths.push(value);
  }
  const patchText = [toolInput.patch, toolInput.input, toolInput.command]
    .map((v) => (Array.isArray(v) ? v.join(' ') : v))
    .find((v): v is string => typeof v === 'string' && v.includes('*** Begin Patch'));
  if (patchText) {
    for (const m of patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
      paths.push(m[1]!.trim());
  }
  const root = real(git(cwd, 'rev-parse', '--show-toplevel') ?? cwd);
  return [
    ...new Set(
      paths.map((p) => {
        const file = real(resolve(cwd, p));
        const rel = relative(root, file);
        return rel.startsWith('..') ? file : rel;
      }),
    ),
  ];
}

/** The real path (macOS /var is /private/var), also for files and folders that do not exist (yet). */
function real(path: string): string {
  const missing: string[] = [];
  let dir = path;
  for (;;) {
    try {
      return join(realpathSync(dir), ...missing.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return path;
      missing.push(basename(dir));
      dir = parent;
    }
  }
}

/** A commit made by this tool call: a shell command with `git commit`, and a HEAD commit from the last 2 minutes. */
function commitMade(input: HookInput, cwd: string): { hash: string; message: string } | undefined {
  const command = input.tool_input?.command;
  const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '';
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(text)) return undefined;
  const line = git(cwd, 'log', '-1', '--format=%h%x09%ct%x09%s');
  if (!line) return undefined;
  const [hash, time, ...subject] = line.split('\t');
  if (!hash || Date.now() / 1000 - Number(time) > 120) return undefined;
  return { hash, message: subject.join('\t') };
}

/** The agent's last reply of the turn: from the hook input, or the last assistant text in the transcript. */
function lastReply(input: HookInput): string | undefined {
  const direct = input.last_assistant_message ?? (input as Record<string, unknown>)['last-assistant-message'];
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (!input.transcript_path || !existsSync(input.transcript_path)) return undefined;
  const lines = readFileSync(input.transcript_path, 'utf8').trim().split('\n').reverse();
  for (const line of lines.slice(0, 200)) {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
      const content = entry.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((c: { type?: string }) => c.type === 'text')
                .map((c: { text?: string }) => c.text ?? '')
                .join('\n')
            : '';
      if (text.trim()) return text;
    } catch {
      // skip lines that are not JSON
    }
  }
  return undefined;
}

/** Claude Code's hooks do not say the model; its transcript does, on each assistant entry. */
function transcriptModel(input: HookInput): string | undefined {
  if (!input.transcript_path || !existsSync(input.transcript_path)) return undefined;
  const lines = readFileSync(input.transcript_path, 'utf8').trim().split('\n').reverse();
  for (const line of lines.slice(0, 200)) {
    try {
      const model = (JSON.parse(line) as { message?: { model?: unknown } }).message?.model;
      if (typeof model === 'string' && model.startsWith('claude')) return model;
    } catch {
      // skip lines that are not JSON
    }
  }
  return undefined;
}

/** The model name from hook input: a string, or an object with an id (agents differ). */
function modelName(model: unknown): string | undefined {
  const value =
    typeof model === 'object' && model !== null && 'id' in model ? (model as { id: unknown }).id : model;
  return typeof value === 'string' && value ? value.slice(0, 100) : undefined;
}

function contextOutput(event: string, context: unknown) {
  if (typeof context !== 'string' || !context) return undefined;
  return { hookSpecificOutput: { hookEventName: EVENT_NAMES[event], additionalContext: context } };
}

async function handle(event: string, input: HookInput, agent: string) {
  const cwd = input.cwd ?? process.cwd();
  const config = loadLocalConfig(cwd);
  if (!config) return undefined; // not a Pair41 project: do nothing
  if (!config.token) {
    log('hooks', { event, error: 'PAIR41_TOKEN is not set' });
    return undefined;
  }
  const sessionId = input.session_id;
  // PAIR41_HOOK_DEBUG=1 logs which fields each agent sends, to pin down formats.
  if (process.env.PAIR41_HOOK_DEBUG) {
    log('hooks', {
      event,
      agent,
      fields: Object.keys(input).sort(),
      tool: input.tool_name,
      model: input.model,
    });
  }

  if (event === 'pre-tool-use') {
    // No server call: tell Pair41 which session this tool call comes from (PLAN.md §6.2). Codex, and Claude Code in
    // auto mode, refuse an updatedInput without an allow, so Pair41's own tools are allowed (docs/specs/protocol.md).
    if (!isPairTool(input.tool_name) || !sessionId) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: "Pair41 adds this session's id (_session) to its own tool calls",
        updatedInput: { ...(input.tool_input ?? {}), _session: sessionId },
      },
    };
  }

  const body: Record<string, unknown> = { agent_session_id: sessionId, cwd };
  const model = modelName(input.model) ?? (event === 'stop' ? transcriptModel(input) : undefined);
  if (model) body.model = model;
  if (event === 'user-prompt-submit') body.prompt = input.prompt;
  if (event === 'post-tool-use') {
    if (isPairTool(input.tool_name)) return undefined; // the tool's own footer already said it
    body.files = filesTouched(input, cwd);
    const commit = commitMade(input, cwd);
    if (commit) body.commit = commit;
  }
  if (event === 'stop') body.last_reply = lastReply(input);
  // A prompt means the agent is busy, and hooks cover busy turns; session end stops everything (docs/specs/protocol.md).
  if (sessionId && (event === 'user-prompt-submit' || event === 'session-end')) {
    stopByPidFile(pidFile('wait', sessionId));
  }
  if (sessionId && event === 'session-end') stopByPidFile(pidFile('bridge', sessionId));

  const result = await postJson(config, agent, `/api/hooks/${event}`, body);
  if (event === 'stop') {
    return typeof result.block === 'string' ? { decision: 'block', reason: result.block } : undefined;
  }
  return contextOutput(event, result.context);
}

export async function runHook(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { agent: { type: 'string' } },
  });
  const event = positionals[0] ?? '';
  if (!(event in EVENT_NAMES)) {
    process.stderr.write(`Unknown hook event "${event}". Known: ${Object.keys(EVENT_NAMES).join(', ')}\n`);
    return 0;
  }
  try {
    const raw = await readStdin();
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    const output = await handle(event, input, agentKind(values.agent));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    log('hooks', { event, error: error instanceof Error ? error.message : String(error) });
  }
  return 0;
}
