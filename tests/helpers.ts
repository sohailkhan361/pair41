// Test helpers: a real server on a temporary database, real MCP clients, and the real CLI.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/server/config.ts';
import { buildApp } from '../src/server/app.ts';
import { createDb } from '../src/store/db.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const BIN = join(ROOT, 'bin', 'pair41');

/**
 * The environment for child processes. It never contains a Claude Code inbox socket: the session running
 * the tests may have its own, and nothing here may ever write to it.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE') || key.startsWith('CODEX') || key.startsWith('PAIR41_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(BIN, args, { env: cleanEnv(opts.env), cwd: opts.cwd ?? ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });
}

export interface TestServer {
  url: string;
  dir: string;
  databaseUrl: string;
  db: ReturnType<typeof createDb>;
  addUser(name: string, password?: string): Promise<string>;
  /** Environment for running the CLI as this user against this server. */
  cliEnv(token: string): Record<string, string>;
  /** A folder with a .pair41.json pointing at this server. */
  projectDir(project: string, extra?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), 'pair41-test-'));
  const pg = process.env.PAIR41_TEST_POSTGRES_URL;
  const databaseUrl =
    process.env.PAIR41_TEST_DATABASE === 'postgres' && pg
      ? `${pg}${pg.includes('?') ? '&' : '?'}schema=t_${randomBytes(6).toString('hex')}`
      : `sqlite:${join(dir, 'test.db')}`;

  const migrated = await runCli(['migrate'], { env: { PAIR41_DATABASE_URL: databaseUrl, PAIR41_HOME: dir } });
  if (migrated.code !== 0) throw new Error(`pair41 migrate failed: ${migrated.stderr}`);

  const db = createDb(databaseUrl);
  const config = loadConfig({ PORT: '0', LOG_LEVEL: 'silent', PAIR41_DATABASE_URL: databaseUrl, ...env });
  const server = buildApp(config, db);
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (server.app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    dir,
    databaseUrl,
    db,
    async addUser(name, password = 'password-123') {
      const res = await runCli(['admin', 'add-user', name, '--password', password], {
        env: { PAIR41_DATABASE_URL: databaseUrl, PAIR41_HOME: dir },
      });
      const token = res.stdout.match(/p41_[A-Za-z0-9_-]+/)?.[0];
      if (res.code !== 0 || !token) throw new Error(`add-user failed: ${res.stderr}`);
      return token;
    },
    cliEnv(token) {
      return { PAIR41_TOKEN: token, PAIR41_HOME: dir };
    },
    async projectDir(project, extra = {}) {
      const folder = await mkdtemp(join(dir, `${project}-`));
      await writeFile(join(folder, '.pair41.json'), JSON.stringify({ server: url, project, ...extra }));
      return folder;
    },
    async close() {
      await server.app.close();
      await db.destroy();
    },
  };
}

// Tool results are untyped JSON; tests read fields from them directly, so `any` is kept to this one type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface ToolResult {
  data: Json;
  text: string;
  footer: string | undefined;
  isError: boolean;
}

export interface TestAgent {
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export async function connectAgent(
  server: { url: string },
  token: string,
  opts: { project?: string; agent?: string; session?: string } = {},
): Promise<TestAgent> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-Pair-Agent': opts.agent ?? 'claude-code',
  };
  if (opts.project) headers['X-Pair-Project'] = opts.project;
  const client = new Client({ name: 'pair41-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers } }),
  );
  return {
    async call(name, args = {}) {
      const res = await client.callTool({
        name,
        arguments: opts.session ? { ...args, _session: opts.session } : args,
      });
      const content = res.content as { type: string; text: string }[];
      const text = content[0]?.text ?? '';
      let data: Json = text;
      try {
        data = JSON.parse(text);
      } catch {
        // Errors are plain text.
      }
      return { data, text, footer: content[1]?.text, isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

/** Two people, each with an agent session in the same project, already paired. */
export async function pairedAgents(server: TestServer, project = 'todo-app') {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const amish = await connectAgent(server, amishToken, { project, agent: 'claude-code', session: 'amish-1' });
  const sam = await connectAgent(server, samToken, { project, agent: 'codex', session: 'sam-1' });
  const requested = await amish.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: requested.data.pair_id, accept: true });
  return { amish, sam, amishToken, samToken, pairId: requested.data.pair_id as string };
}

/** Runs `pair41 hook <event>` as the agent would: hook JSON on stdin, from a folder with .pair41.json. */
export async function runHook(
  server: TestServer,
  token: string,
  folder: string,
  event: string,
  agent: string,
  input: Record<string, unknown>,
) {
  const res = await runCli(['hook', event, '--agent', agent], {
    cwd: folder,
    env: server.cliEnv(token),
    stdin: JSON.stringify({ cwd: folder, hook_event_name: event, ...input }),
  });
  if (res.code !== 0) throw new Error(`pair41 hook ${event} exited ${res.code}: ${res.stderr}`);
  return res.stdout.trim() ? (JSON.parse(res.stdout) as Json) : undefined;
}

export interface WebUser {
  status: number;
  get(path: string): Promise<{ status: number; text: string }>;
  post(path: string, form: Record<string, string>): Promise<{ status: number; text: string }>;
}

/** Logs in on the web page with a username and password, keeping the session cookie. */
export async function webLogin(
  server: { url: string },
  name: string,
  password = 'password-123',
): Promise<WebUser> {
  const res = await fetch(`${server.url}/login`, {
    method: 'POST',
    body: new URLSearchParams({ name, password }),
    redirect: 'manual',
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const request = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${server.url}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), Cookie: cookie },
    });
    return { status: r.status, text: await r.text() };
  };
  return {
    status: res.status,
    get: (path) => request(path),
    post: (path, form) => request(path, { method: 'POST', body: new URLSearchParams(form) }),
  };
}
