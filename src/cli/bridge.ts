// pair41 bridge: started by Claude Code's SessionStart hook (async), only when .pair41.json says "bridge": true. It
// holds a WebSocket to the Pair41 server and writes each pushed message into this session's own inbox socket
// (CLAUDE_CODE_MESSAGING_SOCKET), then reports the attempt. Node built-ins only (global WebSocket, net).
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { loadLocalConfig, log, pair41Home, pidFile, readStdin } from './local.ts';

const WATCH_MS = 5000;

/** Writes the auth line and the message line to the inbox socket, then closes. Rejects on any error. */
export function writeToInbox(socketPath: string, token: string | undefined, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('timed out'));
    }, 5000);
    conn.on('connect', () => {
      if (token) conn.write(`${JSON.stringify({ type: 'auth', token })}\n`);
      conn.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.on('close', (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
  });
}

export async function runBridge(_args: string[]): Promise<number> {
  const raw = await readStdin();
  const input = (raw.trim() ? JSON.parse(raw) : {}) as { session_id?: string; cwd?: string };
  const config = loadLocalConfig(input.cwd ?? process.cwd());
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const socketToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  const sessionId = input.session_id;
  if (!config?.bridge || !config.token || !sessionId) {
    log('bridge', { event: 'not started', reason: 'bridge off, no token or no session id' });
    return 0;
  }
  if (!socketPath || !existsSync(socketPath)) {
    log('bridge', {
      event: 'not started',
      reason: 'no inbox socket (Claude Code 2.1.228 or later is needed)',
    });
    return 0;
  }

  const pidPath = pidFile('bridge', sessionId);
  mkdirSync(pair41Home(), { recursive: true });
  writeFileSync(pidPath, String(process.pid));
  const url = `${config.server.replace(/^http/, 'ws')}/bridge`;
  let socket: WebSocket | undefined;
  let stopping = false;
  let retry = 1000;

  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log('bridge', { event: 'stopped', reason, session: sessionId });
    socket?.close();
    try {
      unlinkSync(pidPath);
    } catch {
      // already gone
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  setInterval(() => {
    if (!existsSync(socketPath)) stop('the inbox socket is gone: the session ended');
  }, WATCH_MS);

  const connect = () => {
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener('open', () => {
      retry = 1000;
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: config.token,
          project: config.project,
          agent: 'claude-code',
          agent_session_id: sessionId,
        }),
      );
    });
    ws.addEventListener('message', (event) => {
      void (async () => {
        const data = JSON.parse(String(event.data)) as {
          type: string;
          message_id?: string;
          text?: string;
          error?: string;
        };
        if (data.type === 'error') log('bridge', { event: 'refused', error: data.error });
        if (data.type !== 'push' || !data.text) return;
        try {
          await writeToInbox(socketPath, socketToken, data.text);
          if (data.message_id)
            ws.send(JSON.stringify({ type: 'attempt', message_id: data.message_id, result: 'written' }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log('bridge', { event: 'write failed', message_id: data.message_id, error: detail });
          if (data.message_id) {
            ws.send(
              JSON.stringify({ type: 'attempt', message_id: data.message_id, result: 'error', detail }),
            );
          }
        }
      })();
    });
    ws.addEventListener('close', () => {
      if (stopping) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
    ws.addEventListener('error', () => {
      // 'close' follows and reconnects
    });
  };
  connect();
  log('bridge', { event: 'started', session: sessionId, server: config.server });
  return new Promise<number>(() => {}); // runs until stopped
}
