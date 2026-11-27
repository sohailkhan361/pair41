// pair41 doctor: checks the agent-side setup and prints a fix for anything that fails. Read-only: it never changes a
// config and never writes to the inbox socket. For Claude Code it knows the three setups (docs/specs/protocol.md,
// "Claude Code plugin"): the plugin, `pair41 install` and connect-claude.sh.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentKind, headers, loadLocalConfig, pair41Home, type LocalConfig } from './local.ts';

let failures = 0;

function pass(text: string) {
  console.log(`✔ ${text}`);
}

function fail(text: string, fix: string) {
  failures += 1;
  console.log(`✘ ${text}\n    fix: ${fix}`);
}

function note(text: string) {
  console.log(`· ${text}`);
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function run(cmd: string, args: string[], cwd: string): string | undefined {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
}

/** "2.1.228" ≥ "2.1.228" */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The plugin's folder when this is the plugin's own copy of pair41 (its bin/pair41 sets PAIR41_PLUGIN). */
const pluginRoot = () => process.env.PAIR41_PLUGIN;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const CLAUDE_EVENTS = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'stop',
  'session-end',
];

/** Where the fixes send the person: the plugin's settings, or the clone they ran pair41 install from. */
type Fixes = { server: string; token: string };

function fixesFor(plugin: string | undefined): Fixes {
  return plugin
    ? {
        server: 'check the server is up, or change the server with /plugin manage',
        token: 'get a new one on the Pair41 page ("Connect your agent") and enter it with /plugin manage',
      }
    : {
        server:
          'start the server, or fix the server address (PAIR41_SERVER, .pair41.json or ~/.pair41/config.json)',
        token:
          'get a new one on the Pair41 page ("Connect your agent") and run bin/pair41 install --token p41_... again',
      };
}

/** The Pair41 plugin as Claude Code lists it, when it is installed and enabled for this folder. */
function listedPlugin(root: string): { id: string; version?: string } | undefined {
  const listing = run('claude', ['plugin', 'list', '--json'], root);
  if (!listing) return undefined;
  try {
    const plugins = JSON.parse(listing) as { id?: string; version?: string; enabled?: boolean }[];
    const found = plugins.find((p) => p.id?.startsWith('pair41@') && p.enabled === true);
    return found?.id ? { id: found.id, version: found.version } : undefined;
  } catch {
    return undefined;
  }
}

function pluginVersion(root: string): string | undefined {
  const manifest = read(join(root, '.claude-plugin', 'plugin.json'));
  try {
    return manifest ? (JSON.parse(manifest) as { version?: string }).version : undefined;
  } catch {
    return undefined;
  }
}

/** Where the server and project came from, as loadLocalConfig picks them. */
function settingsSource(config: LocalConfig, plugin: string | undefined): string {
  if (plugin && process.env.CLAUDE_PLUGIN_OPTION_SERVER) return 'the plugin settings';
  if (process.env.PAIR41_SERVER) return 'PAIR41_SERVER';
  if (existsSync(join(config.root, '.pair41.json'))) return `.pair41.json in ${config.root}`;
  return join(pair41Home(), 'config.json');
}

async function checkServer(config: LocalConfig, agent: string, fixes: Fixes) {
  try {
    const live = await fetch(`${config.server}/live`, { signal: AbortSignal.timeout(5000) });
    if (live.ok) pass(`Pair41 server reachable at ${config.server}`);
    else fail(`${config.server}/live answered ${live.status}`, fixes.server);
  } catch (error) {
    fail(`cannot reach ${config.server} (${(error as Error).message})`, fixes.server);
    return;
  }
  if (!config.token) return;
  const me = await fetch(`${config.server}/api/me`, {
    headers: headers(config, agent),
    signal: AbortSignal.timeout(5000),
  });
  if (me.ok) {
    const body = (await me.json()) as { name: string };
    pass(`agent token accepted: you are ${body.name}`);
  } else if (me.status === 401) {
    fail('the agent token was rejected', fixes.token);
  } else if (me.status === 403) {
    fail(
      `the server does not accept the host in ${config.server}`,
      'add the host to PAIR41_ALLOWED_HOSTS on the server',
    );
  } else {
    fail(`/api/me answered ${me.status}`, 'check the server logs');
  }
  const mcp = await fetch(`${config.server}/mcp`, {
    method: 'POST',
    headers: { ...headers(config, agent), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pair41-doctor', version: '1' },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (mcp.ok) pass(`MCP endpoint answers at ${config.server}/mcp`);
  else if (mcp.status !== 401 && mcp.status !== 403) {
    fail(
      `MCP endpoint answered ${mcp.status}`,
      'the URL must be exactly <server>/mcp, with no trailing slash',
    );
  }
}

function checkClaude(config: LocalConfig) {
  const plugin = pluginRoot();
  const listed = listedPlugin(config.root);
  const projectFiles = [
    join(config.root, '.claude', 'settings.local.json'),
    join(config.root, '.claude', 'settings.json'),
  ];
  const projectSettings = projectFiles.map(read).join('\n');
  const userFile = join(claudeDir(), 'settings.json');
  const userSettings = read(userFile) ?? '';
  const hasPair41Hooks = (text: string) => text.includes('hook session-start --agent');
  const others: string[] = [];
  const removals: string[] = [];
  if (hasPair41Hooks(userSettings)) {
    others.push(`pair41 install (${userFile})`);
    removals.push('run bin/pair41 uninstall from a clone');
  }
  if (hasPair41Hooks(projectSettings)) {
    others.push(`connect-claude.sh (${join(config.root, '.claude')})`);
    removals.push(`take Pair41's hooks out of ${join(config.root, '.claude')}`);
  }

  if (plugin || listed) {
    const version = plugin ? pluginVersion(plugin) : listed?.version;
    pass(
      `the Pair41 plugin${version ? ` ${version}` : ''} is enabled: it brings the MCP server, the hooks with the waiter and the pair41 skill`,
    );
    if (others.length) {
      fail(
        `Pair41 is also set up by ${others.join(' and ')}, so every hook runs twice`,
        `keep the plugin: ${removals.join(', and ')}`,
      );
    }
  } else if (!others.length) {
    fail(
      'Pair41 is not set up for Claude Code',
      'install the Pair41 plugin in Claude Code (/plugin), or run bin/pair41 install from a clone',
    );
  } else {
    pass(`Pair41 is set up by ${others.join(' and ')}`);
    if (others.length > 1) {
      fail('Pair41 is set up twice, so every hook runs twice', `keep one: ${removals[1]}`);
    }
    const again = hasPair41Hooks(userSettings)
      ? 'run bin/pair41 install again from a clone'
      : 'run agent-kit/connect-claude.sh here again';
    const listing = run('claude', ['mcp', 'get', 'pair'], config.root);
    if (listing === undefined) {
      fail('Claude Code has no MCP server called "pair" in this folder', again);
    } else if (!listing.includes(`${config.server}/mcp`)) {
      fail(`the "pair" MCP server does not point at ${config.server}/mcp`, again);
    } else {
      pass('Claude Code has the "pair" MCP server');
    }
    const settings = `${projectSettings}\n${userSettings}`;
    const missing = CLAUDE_EVENTS.filter((e) => !settings.includes(`hook ${e}`));
    if (missing.length) fail(`Claude Code hooks missing: ${missing.join(', ')}`, again);
    else pass('Claude Code hooks installed');
    if (settings.includes('wait --agent'))
      pass('wake on: the waiter wakes this session when its partner needs it');
    else note(`wake off: ${again} to add the waiter`);
    const skills = [
      join(config.root, '.claude', 'skills', 'pair41', 'SKILL.md'),
      join(claudeDir(), 'skills', 'pair41', 'SKILL.md'),
    ];
    if (skills.some((file) => existsSync(file))) pass('pair41 skill installed');
    else fail('pair41 skill missing', again);
  }

  if (!config.bridge) {
    note('bridge off (turn it on with connect-claude.sh --with-bridge, only once P41 agrees)');
    return;
  }
  const version = run('claude', ['--version'], config.root)?.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) fail('cannot read the Claude Code version', 'check that `claude --version` works');
  else if (versionAtLeast(version, '2.1.228')) pass(`Claude Code ${version} has the inbox socket and token`);
  else fail(`Claude Code ${version} is older than 2.1.228`, 'update Claude Code');
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socket) {
    note('inbox socket not checked: run this inside Claude Code (! pair41 doctor) to check it');
  } else if (existsSync(socket) && statSync(socket).isSocket()) {
    pass(`inbox socket exists (${socket}); doctor does not write to it`);
  } else {
    fail(`CLAUDE_CODE_MESSAGING_SOCKET points at ${socket}, which is not a socket`, 'see PLAN.md §8.0');
  }
  if (!process.env.CLAUDE_CODE_MESSAGING_TOKEN && socket) {
    fail('CLAUDE_CODE_MESSAGING_TOKEN is not set', 'update Claude Code to 2.1.228 or later');
  }
}

const CODEX_SETUP = 'run bin/pair41 install --agents codex from a clone (or agent-kit/connect-codex.sh here)';

function checkCodex(config: LocalConfig) {
  const project = read(join(config.root, '.codex', 'config.toml')) ?? '';
  const user = read(join(homedir(), '.codex', 'config.toml')) ?? '';
  const source = project.includes('[mcp_servers.pair]') ? project : user;
  if (!source.includes('[mcp_servers.pair]')) {
    fail('Codex has no [mcp_servers.pair]', CODEX_SETUP);
  } else if (!source.includes(`${config.server}/mcp`)) {
    fail(`[mcp_servers.pair] does not point at ${config.server}/mcp`, 'fix the url in .codex/config.toml');
  } else {
    pass(`Codex has the "pair" MCP server (${source === project ? 'project' : 'user'} config)`);
  }
  const hooks =
    read(join(config.root, '.codex', 'hooks.json')) ?? read(join(homedir(), '.codex', 'hooks.json')) ?? '';
  const missing = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'stop'].filter(
    (e) => !hooks.includes(`hook ${e}`),
  );
  if (missing.length) fail(`Codex hooks missing: ${missing.join(', ')}`, CODEX_SETUP);
  else pass('Codex hooks installed');
  note('Codex hooks only run after you trust them once with /hooks in Codex; doctor cannot see that.');
}

export async function runDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { agent: { type: 'string' } } });
  const agent = agentKind(values.agent);
  failures = 0;
  const plugin = pluginRoot();
  const fixes = fixesFor(plugin);
  const loaded = loadLocalConfig(process.cwd());
  if (!loaded) {
    fail(
      'no Pair41 server is set for this folder',
      plugin
        ? 'enter the server with /plugin manage'
        : 'install the Pair41 plugin in Claude Code (/plugin), or run bin/pair41 install from a clone',
    );
    return 1;
  }
  // Run by hand, the plugin's copy has the plugin's server but not its token, which Claude Code keeps: an older
  // PAIR41_TOKEN or ~/.pair41/config.json would not be the token the plugin uses.
  const tokenUnknown = !!plugin && !process.env.CLAUDE_PLUGIN_OPTION_TOKEN;
  const config: LocalConfig = tokenUnknown ? { ...loaded, token: undefined } : loaded;
  pass(`server ${config.server}, project ${config.project} (from ${settingsSource(config, plugin)})`);
  if (tokenUnknown) {
    note(
      'the plugin keeps your agent token in Claude Code, where doctor cannot read it: the Pair41 tool pair_status checks it',
    );
  } else if (!config.token) {
    fail(
      'no agent token (PAIR41_TOKEN or ~/.pair41/config.json)',
      'run bin/pair41 install --token p41_... from a clone',
    );
  } else if (!config.token.startsWith('p41_')) {
    fail('the agent token does not look like a Pair41 token (p41_...)', 'copy it again from the Pair41 page');
  } else {
    pass('agent token set');
  }
  if (!config.token || config.token.startsWith('p41_')) await checkServer(config, agent, fixes);
  if (agent === 'claude-code') checkClaude(config);
  else if (agent === 'codex') checkCodex(config);
  else note("pass --agent claude-code or --agent codex to check that agent's MCP config and hooks");
  console.log(failures ? `\n${failures} problem${failures > 1 ? 's' : ''} found.` : '\nAll good.');
  return failures ? 1 : 0;
}
