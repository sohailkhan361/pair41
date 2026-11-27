// pair41 run -- <command>: runs an agent (Codex) inside a small wrapper that types "check pair" into it when a partner
// message arrives and the agent is idle (PLAN.md §5 P1 item 6). Idle means: Pair41 does not have the session as busy,
// the agent printed nothing for a while, and the human typed nothing for a while. It types once per new message.
// In a terminal it uses node-pty (an optional dependency) so the agent gets a real TTY; otherwise plain pipes.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { headers, loadLocalConfig, log } from './local.ts';

/** The pause between typing "check pair" and pressing Enter. */
const ENTER_DELAY_MS = 500;

interface Child {
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
  resize?(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): {
    write(data: string): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number }) => void): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  };
}

/** node-pty, if it is installed. Its prebuilt spawn-helper sometimes ships without the execute bit; fix that. */
async function loadPty(): Promise<PtyModule | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('node-pty/package.json'));
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
    return (await import('node-pty')) as unknown as PtyModule;
  } catch {
    return undefined;
  }
}

async function startChild(command: string, args: string[]): Promise<{ child: Child; newline: string }> {
  const pty = process.stdin.isTTY ? await loadPty() : undefined;
  if (pty) {
    const term = pty.spawn(command, args, {
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
      env: process.env,
    });
    return {
      newline: '\r',
      child: {
        write: (data) => term.write(data),
        onData: (listener) => term.onData(listener),
        onExit: (listener) => term.onExit((e) => listener(e.exitCode)),
        resize: (cols, rows) => term.resize(cols, rows),
        kill: () => term.kill(),
      },
    };
  }
  const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    newline: '\n',
    child: {
      write: (data) => proc.stdin.write(data),
      onData: (listener) => {
        proc.stdout.on('data', (d: Buffer) => listener(d.toString()));
        proc.stderr.on('data', (d: Buffer) => listener(d.toString()));
      },
      onExit: (listener) => proc.on('exit', (code) => listener(code ?? 0)),
      kill: () => proc.kill('SIGTERM'),
    },
  };
}

export async function runWrapper(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { agent: { type: 'string', default: 'codex' } },
  });
  const [command, ...commandArgs] = positionals;
  if (!command) {
    process.stderr.write('Usage: pair41 run [--agent codex] -- <command> [args]\n');
    return 2;
  }
  const config = loadLocalConfig(process.cwd());
  if (!config?.token) {
    process.stderr.write(
      'pair41 run needs a .pair41.json here (or above) and PAIR41_TOKEN. Starting the agent without it.\n',
    );
  }
  const pollMs = Number(process.env.PAIR41_WRAPPER_POLL_MS ?? 2000);
  const quietMs = Number(process.env.PAIR41_WRAPPER_QUIET_MS ?? 5000);

  const { child, newline } = await startChild(command, commandArgs);
  let lastOutput = Date.now();
  let lastInput = 0;
  let typedFor = 0; // the newest message id we already typed "check pair" for

  child.onData((data) => {
    lastOutput = Date.now();
    process.stdout.write(data);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (data: Buffer) => {
    lastInput = Date.now();
    child.write(data.toString());
  });
  process.stdout.on('resize', () => child.resize?.(process.stdout.columns, process.stdout.rows));

  const exitCode = new Promise<number>((resolve) => child.onExit(resolve));
  process.on('SIGTERM', () => child.kill());

  const poll = async () => {
    if (!config?.token) return;
    try {
      const res = await fetch(`${config.server}/api/unread`, {
        headers: headers(config, values.agent ?? 'codex'),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const status = (await res.json()) as { state?: string; latest: number };
      const now = Date.now();
      const idle = status.state !== 'busy' && now - lastOutput >= quietMs && now - lastInput >= quietMs;
      if (status.latest > typedFor && idle) {
        typedFor = status.latest;
        // TUIs such as Codex take text and Enter that arrive together as a paste, where Enter only adds a new line.
        // So Enter goes on its own, a moment later, and submits.
        child.write('check pair');
        setTimeout(() => child.write(newline), ENTER_DELAY_MS);
        log('wrapper', { event: 'typed check pair', message: status.latest });
      }
    } catch (error) {
      log('wrapper', { event: 'poll failed', error: error instanceof Error ? error.message : String(error) });
    }
  };
  const timer = setInterval(() => void poll(), pollMs);

  const code = await exitCode;
  clearInterval(timer);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  return code;
}
