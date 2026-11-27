// pair41 wait: the waiter (docs/specs/protocol.md, "Wake"). Claude Code runs it after every turn as a background
// Stop hook (asyncRewake). It asks the Pair41 server, again and again, whether its session has something worth a
// turn. On a wake it prints the line on stderr and exits 2, which makes Claude Code wake Claude even when the
// session is idle. Node built-ins only, so the plugin can ship it.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  agentKind,
  headers,
  loadLocalConfig,
  log,
  pair41Home,
  pidFile,
  readStdin,
  stopByPidFile,
} from './local.ts';

/** How long each request to /api/wait is held. */
const POLL_SECONDS = 25;
/** Under the hook's own time limit (29100 s), so Claude Code never has to kill the waiter. */
const MAX_LIFE_MS = 8 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;
/** Without reaching the server for this long, give up: it was stopped, or moved. */
const GIVE_UP_MS = 10 * 60 * 1000;

export async function runWait(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { agent: { type: 'string' } } });
  const agent = agentKind(values.agent);
  let input: { session_id?: string; cwd?: string };
  let config: ReturnType<typeof loadLocalConfig>;
  try {
    const raw = await readStdin();
    input = (raw.trim() ? JSON.parse(raw) : {}) as { session_id?: string; cwd?: string };
    config = loadLocalConfig(input.cwd ?? process.cwd());
  } catch (error) {
    log('wait', { event: 'not started', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
  const sessionId = input.session_id;
  // The bridge, when it is on, already pushes into the session.
  if (!config || !config.token || !sessionId || config.bridge) return 0;

  // One waiter per session: the newest one replaces the one before.
  const file = pidFile('wait', sessionId);
  stopByPidFile(file);
  mkdirSync(pair41Home(), { recursive: true });
  writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
    } catch {
      // already gone or replaced
    }
  };
  const quit = () => {
    release();
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);

  const url = `${config.server}/api/wait?session=${encodeURIComponent(sessionId)}&timeout=${POLL_SECONDS}`;
  const started = Date.now();
  const parent = process.ppid;
  let retry = FIRST_RETRY_MS;
  let failingSince: number | undefined;
  log('wait', { event: 'started', session: sessionId });
  try {
    while (Date.now() - started < MAX_LIFE_MS) {
      if (process.ppid !== parent) {
        log('wait', { event: 'stopped', session: sessionId, reason: 'the agent is gone' });
        return 0;
      }
      try {
        const res = await fetch(url, {
          headers: headers(config, agent),
          signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          wake?: unknown;
          stop?: unknown;
          error?: unknown;
        };
        if (res.status >= 400 && res.status < 500) {
          log('wait', {
            event: 'stopped',
            session: sessionId,
            reason: `${res.status} ${String(body.error ?? '')}`,
          });
          return 0;
        }
        if (!res.ok) throw new Error(`GET /api/wait → ${res.status}`);
        retry = FIRST_RETRY_MS;
        failingSince = undefined;
        if (typeof body.wake === 'string') {
          log('wait', { event: 'wake', session: sessionId });
          process.stderr.write(`${body.wake}\n`);
          return 2;
        }
        if (typeof body.stop === 'string') {
          log('wait', { event: 'stopped', session: sessionId, reason: body.stop });
          return 0;
        }
      } catch (error) {
        log('wait', {
          event: 'retry',
          session: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= GIVE_UP_MS) {
          log('wait', { event: 'stopped', session: sessionId, reason: 'the server is unreachable' });
          return 0;
        }
        await new Promise((resolve) => setTimeout(resolve, retry));
        retry = Math.min(retry * 2, MAX_RETRY_MS);
      }
    }
    log('wait', { event: 'stopped', session: sessionId, reason: 'waited 8 hours' });
    return 0;
  } finally {
    release();
  }
}
