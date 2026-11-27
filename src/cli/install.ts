// pair41 install / uninstall: set Pair41 up once for your user, so any Claude Code or Codex session you start, in
// any folder, can join a pair when you give it the pair code. It writes ~/.pair41/config.json (server and token),
// registers the MCP server, adds the hooks and the pair41 skill to each agent's user config. Until a session joins a
// pair, the hooks only tell Pair41 the session exists. Sessions already running need one restart to load it.
// `PAIR41_OFF=1` turns it off for one session; `pair41 uninstall` removes it all.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadUserConfig, pair41Home, userConfigFile } from './local.ts';

const BIN = resolve(import.meta.dirname, '..', '..', 'bin', 'pair41');
const SKILL = resolve(import.meta.dirname, '..', '..', 'agent-kit', 'skills', 'pair41', 'SKILL.md');
const BEGIN = '# >>> pair41 (written by pair41 install; pair41 uninstall removes it)';
const END = '# <<< pair41';

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexDir = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');

function has(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

function writeFile(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

type Hook = { type: string; command: string; asyncRewake?: boolean; timeout?: number };
type HookGroup = { matcher?: string; hooks: Hook[] };

/**
 * The waiter (docs/specs/protocol.md, "Wake"): a second Stop hook that Claude Code runs in the background after
 * every turn; exit code 2 wakes Claude even when the session is idle. Its time limit is above the waiter's 8 hours.
 */
const WAIT_HOOK: Hook = {
  type: 'command',
  command: `"${BIN}" wait --agent claude-code`,
  asyncRewake: true,
  timeout: 29100,
};

/** Merges Pair41's hook groups into a hooks file, keeping everyone else's; with `remove`, only takes ours out. */
function mergeHooks(file: string, ours: Record<string, HookGroup[]>, remove = false) {
  const settings = readJson(file);
  const before = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const events = new Set([...Object.keys(before), ...Object.keys(ours)]);
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of events) {
    const others = (before[event] ?? []).filter((g) => !JSON.stringify(g).includes('pair41'));
    const groups = remove ? others : [...others, ...(ours[event] ?? [])];
    if (groups.length) hooks[event] = groups;
  }
  settings.hooks = hooks;
  writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function hookGroups(agent: string, events: string[], matchers: Record<string, string> = {}) {
  const names: Record<string, string> = {
    SessionStart: 'session-start',
    UserPromptSubmit: 'user-prompt-submit',
    PreToolUse: 'pre-tool-use',
    PostToolUse: 'post-tool-use',
    Stop: 'stop',
    SessionEnd: 'session-end',
  };
  const groups: Record<string, HookGroup[]> = {};
  for (const event of events) {
    const command = `"${BIN}" hook ${names[event]} --agent ${agent}`;
    groups[event] = [
      { ...(matchers[event] ? { matcher: matchers[event] } : {}), hooks: [{ type: 'command', command }] },
    ];
  }
  return groups;
}

/** config.toml without our block. */
function withoutBlock(toml: string): string {
  const start = toml.indexOf(BEGIN);
  const end = toml.indexOf(END);
  if (start === -1 || end === -1) return toml;
  return (toml.slice(0, start).trimEnd() + '\n' + toml.slice(end + END.length).trimStart()).trim() + '\n';
}

function installClaude(server: string, token: string): string[] {
  const done: string[] = [];
  try {
    execFileSync('claude', ['mcp', 'remove', 'pair', '-s', 'user'], { stdio: 'ignore' });
  } catch {
    // not there yet
  }
  execFileSync(
    'claude',
    [
      'mcp',
      'add',
      '--transport',
      'http',
      'pair',
      `${server}/mcp`,
      '-s',
      'user',
      '--header',
      `Authorization: Bearer ${token}`,
      '--header',
      'X-Pair-Agent: claude-code',
    ],
    { stdio: 'ignore' },
  );
  done.push('MCP server "pair" (user scope)');
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
  const groups = hookGroups('claude-code', events, { PreToolUse: 'mcp__.*pair__.*' });
  groups.Stop?.[0]?.hooks.push(WAIT_HOOK);
  mergeHooks(join(claudeDir(), 'settings.json'), groups);
  done.push(`hooks in ${join(claudeDir(), 'settings.json')}`);
  writeFile(join(claudeDir(), 'skills', 'pair41', 'SKILL.md'), readFileSync(SKILL, 'utf8'));
  done.push('the pair41 skill');
  return done;
}

function installCodex(server: string, token: string): string[] {
  const done: string[] = [];
  const configFile = join(codexDir(), 'config.toml');
  const toml = withoutBlock(existsSync(configFile) ? readFileSync(configFile, 'utf8') : '');
  if (/^\[mcp_servers\.pair\]/m.test(toml)) {
    done.push(`left your own [mcp_servers.pair] in ${configFile} as it is`);
  } else {
    // The token is written here rather than read from the environment: Codex Desktop is not started from a shell.
    const block = [
      BEGIN,
      '[mcp_servers.pair]',
      `url = "${server}/mcp"`,
      `http_headers = { "Authorization" = "Bearer ${token}", "X-Pair-Agent" = "codex" }`,
      'default_tools_approval_mode = "approve"',
      END,
    ].join('\n');
    writeFile(configFile, `${toml.trimEnd()}\n\n${block}\n`.trimStart());
    chmodSync(configFile, 0o600);
    done.push(`MCP server "pair" in ${configFile}`);
  }
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  mergeHooks(join(codexDir(), 'hooks.json'), hookGroups('codex', events));
  done.push(`hooks in ${join(codexDir(), 'hooks.json')}`);
  for (const dir of [join(homedir(), '.agents', 'skills', 'pair41'), join(codexDir(), 'skills', 'pair41')]) {
    writeFile(join(dir, 'SKILL.md'), readFileSync(SKILL, 'utf8'));
  }
  done.push('the pair41 skill');
  return done;
}

export async function runInstall(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { server: { type: 'string' }, token: { type: 'string' }, agents: { type: 'string' } },
  });
  const previous = loadUserConfig();
  const server = (
    values.server ??
    process.env.PAIR41_SERVER ??
    previous.server ??
    'http://localhost:8765'
  ).replace(/\/$/, '');
  const token = values.token ?? process.env.PAIR41_TOKEN ?? previous.token;
  if (!token) {
    process.stderr.write(
      `Give your agent token: pair41 install --token p41_... (log in at ${server}, "Connect your agent").\n`,
    );
    return 1;
  }
  let name: string;
  try {
    const res = await fetch(`${server}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    name = ((await res.json()) as { name: string }).name;
  } catch (error) {
    process.stderr.write(`Could not check the token with ${server}: ${String(error)}\n`);
    return 1;
  }
  const agents = (values.agents ?? 'claude-code,codex').split(',').map((a) => a.trim());

  mkdirSync(pair41Home(), { recursive: true });
  writeFileSync(userConfigFile(), `${JSON.stringify({ server, token }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Pair41 is set up for ${name} on ${server} (${userConfigFile()}).\n`);

  for (const agent of agents) {
    const command = agent === 'claude-code' ? 'claude' : agent;
    if (!has(command)) {
      process.stdout.write(`- ${agent}: the ${command} command is not installed, skipped.\n`);
      continue;
    }
    const done = agent === 'claude-code' ? installClaude(server, token) : installCodex(server, token);
    process.stdout.write(`- ${agent}: ${done.join(', ')}.\n`);
  }
  process.stdout.write(`
Any Claude Code or Codex session you start from now on, in any folder, can join a pair. Pairs are between people:
ask a teammate on the Pair41 page, they accept, then each of you tells your own agent "join Pair41 pair <code>"
(the code is on the pair page). Sessions that were already running need one restart (claude --resume <id>,
codex resume <id>). Codex asks you to trust new hooks once: run /hooks in Codex. To turn Pair41 off for one session,
start it with PAIR41_OFF=1; to remove everything: pair41 uninstall.
`);
  return 0;
}

export async function runUninstall(): Promise<number> {
  if (has('claude')) {
    try {
      execFileSync('claude', ['mcp', 'remove', 'pair', '-s', 'user'], { stdio: 'ignore' });
    } catch {
      // was not there
    }
    const settings = join(claudeDir(), 'settings.json');
    if (existsSync(settings)) mergeHooks(settings, {}, true);
    rmSync(join(claudeDir(), 'skills', 'pair41'), { recursive: true, force: true });
  }
  const configFile = join(codexDir(), 'config.toml');
  if (existsSync(configFile)) writeFileSync(configFile, withoutBlock(readFileSync(configFile, 'utf8')));
  const codexHooks = join(codexDir(), 'hooks.json');
  if (existsSync(codexHooks)) mergeHooks(codexHooks, {}, true);
  rmSync(join(homedir(), '.agents', 'skills', 'pair41'), { recursive: true, force: true });
  rmSync(join(codexDir(), 'skills', 'pair41'), { recursive: true, force: true });
  rmSync(userConfigFile(), { force: true });
  process.stdout.write(
    'Pair41 is removed from Claude Code and Codex. Restart running sessions to drop it there.\n',
  );
  return 0;
}
