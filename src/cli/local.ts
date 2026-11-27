// What the agent-side commands need: the server, the project, the agent token, a log file, and HTTP calls to the
// Pair41 server. Node built-ins only, so the plugin can ship this code as is.
//
// Where they come from, first match wins: PAIR41_SERVER / PAIR41_PROJECT / PAIR41_TOKEN; a .pair41.json in the
// folder or a parent (set up per repo by agent-kit/connect-*.sh); ~/.pair41/config.json (set up once by
// `pair41 install`, so every agent session anywhere can pair), with the git repo's folder name as the project.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface LocalConfig {
  /** The folder that holds .pair41.json. */
  root: string;
  server: string;
  project: string;
  bridge: boolean;
  token: string | undefined;
}

export interface UserConfig {
  server?: string;
  token?: string;
}

export function userConfigFile(): string {
  return join(pair41Home(), 'config.json');
}

/** ~/.pair41/config.json, written by `pair41 install`. */
export function loadUserConfig(): UserConfig {
  try {
    return JSON.parse(readFileSync(userConfigFile(), 'utf8')) as UserConfig;
  } catch {
    return {};
  }
}

/** The git repo's folder name, or the folder's own name outside a repo. */
function projectFor(cwd: string): string {
  let root = cwd;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // not a git repo
  }
  // Project names are letters, digits, ., - and _ (up to 64).
  return (
    basename(root)
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64) || 'default'
  );
}

/**
 * The settings for `cwd`. Undefined when Pair41 is not set up for it (no .pair41.json and no `pair41 install`), or
 * when PAIR41_OFF is set.
 */
export function loadLocalConfig(cwd: string): LocalConfig | undefined {
  if (process.env.PAIR41_OFF) return undefined;
  const user = loadUserConfig();
  let dir = cwd;
  for (;;) {
    const file = join(dir, '.pair41.json');
    if (existsSync(file)) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        server?: string;
        project?: string;
        bridge?: boolean;
      };
      const server = process.env.PAIR41_SERVER ?? json.server ?? user.server;
      const project = process.env.PAIR41_PROJECT ?? json.project;
      if (!server || !project) throw new Error(`${file} needs "server" and "project"`);
      return {
        root: dir,
        server: server.replace(/\/$/, ''),
        project,
        bridge: json.bridge === true,
        token: process.env.PAIR41_TOKEN ?? user.token,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const server = process.env.PAIR41_SERVER ?? user.server;
  if (!server) return undefined;
  return {
    root: cwd,
    server: server.replace(/\/$/, ''),
    project: process.env.PAIR41_PROJECT ?? projectFor(cwd),
    bridge: false,
    token: process.env.PAIR41_TOKEN ?? user.token,
  };
}

export function pair41Home(): string {
  return process.env.PAIR41_HOME ?? join(homedir(), '.pair41');
}

/** $PAIR41_HOME/<kind>-<agent session id>.pid: the bridge's or the waiter's, one per session. */
export function pidFile(kind: 'bridge' | 'wait', sessionId: string): string {
  return join(pair41Home(), `${kind}-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.pid`);
}

/** Stops the process named in a pid file, if there is one, and removes the file. Never throws. */
export function stopByPidFile(file: string): void {
  if (!existsSync(file)) return;
  try {
    process.kill(Number(readFileSync(file, 'utf8')), 'SIGTERM');
  } catch {
    // already gone
  }
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

/** Appends one JSON line to $PAIR41_HOME/<name>.log. Never throws. */
export function log(name: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(pair41Home(), { recursive: true });
    appendFileSync(
      join(pair41Home(), `${name}.log`),
      `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Logging must never break a hook.
  }
}

export function headers(config: LocalConfig, agent: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token ?? ''}`,
    'X-Pair-Agent': agent,
    'X-Pair-Project': config.project,
    'User-Agent': 'pair41-cli/0.1.0',
  };
}

export async function postJson(
  config: LocalConfig,
  agent: string,
  path: string,
  body: unknown,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.server}${path}`, {
    method: 'POST',
    headers: headers(config, agent),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${String(json.error ?? '')}`);
  return json;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The agent kind: --agent, else Claude Code when its environment says so, else "other". */
export function agentKind(flag: string | undefined): string {
  if (flag) return flag;
  if (process.env.CLAUDECODE === '1') return 'claude-code';
  return 'other';
}
