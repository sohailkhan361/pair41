// Quick metrics for the README (PLAN.md §11.5): page load time and send-to-receipt time against a local server on a
// temporary SQLite database. Time to answer comes from real use: GET /api/analytics. Run: scripts/bench.sh
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'pair41');
const ROUNDS = 30;

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('CLAUDE') && !k.startsWith('PAIR41_')) out[k] = v;
  return { ...out, ...extra };
}

function run(args: string[], extra: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    const child = spawn(BIN, args, { env: env(extra) });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => done(out));
  });
}

async function timed(fn: () => Promise<unknown>): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b);
}

const p = (times: number[], q: number) =>
  times[Math.min(times.length - 1, Math.floor(times.length * q))]!.toFixed(1);

const work = await mkdtemp(join(tmpdir(), 'pair41-bench-'));
const serverEnv = { PAIR41_DATABASE_URL: `sqlite:${join(work, 'bench.db')}`, PAIR41_HOME: work };
await run(['migrate'], serverEnv);
const token = async (name: string) =>
  (await run(['admin', 'add-user', name, '--password', 'bench-password'], serverEnv)).match(/p41_[\w-]+/)![0];
const [amishToken, samToken] = [await token('amish'), await token('sam')];
const port = String(20000 + Math.floor(Math.random() * 20000));
const url = `http://127.0.0.1:${port}`;
const server = spawn(BIN, ['serve'], { env: env({ ...serverEnv, PORT: port, LOG_LEVEL: 'warn' }) });
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${url}/ready`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 100));
}

const agent = async (tok: string, kind: string, session: string) => {
  const client = new Client({ name: 'bench', version: '1' });
  const headers = { Authorization: `Bearer ${tok}`, 'X-Pair-Agent': kind, 'X-Pair-Project': 'bench' };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }),
  );
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: { ...args, _session: session } });
    return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, string>;
  };
};
const claude = await agent(amishToken, 'claude-code', 'bench-claude');
const codex = await agent(samToken, 'codex', 'bench-codex');
const pair = await claude('request_pair', { teammate: 'sam', feature: 'Bench' });
await codex('respond_to_pair', { pair_id: pair.pair_id!, accept: true });

const login = await fetch(`${url}/login`, {
  method: 'POST',
  body: new URLSearchParams({ name: 'sam', password: 'bench-password' }),
  redirect: 'manual',
});
const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
const page = (path: string) => () =>
  fetch(`${url}${path}`, { headers: { Cookie: cookie } }).then((r) => r.text());

const rows = [
  ['Login page load', await timed(page('/login'))],
  ['Lobby page load', await timed(page('/lobby'))],
  ['Pair room page load', await timed(page(`/pairs/${pair.pair_id!.slice(2)}`))],
  ['send_message → receipt', await timed(() => codex('send_message', { kind: 'chat', text: 'ping' }))],
  ['check_messages', await timed(() => claude('check_messages'))],
] as const;

console.log(`| Measure (local, SQLite, ${ROUNDS} runs) | median ms | p90 ms |`);
console.log('| --- | --- | --- |');
for (const [name, times] of rows) console.log(`| ${name} | ${p(times, 0.5)} | ${p(times, 0.9)} |`);

server.kill('SIGTERM');
await rm(work, { recursive: true, force: true });
process.exit(0);
