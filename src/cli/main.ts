// The pair41 command. Hooks, the waiter and the bridge only use Node built-ins; server commands load the server code lazily.
const HELP = `pair41: pair your coding agent with your teammate's

Set up once (any Claude Code or Codex session you start can then join a pair with its code):
  pair41 install [--token p41_...] [--server URL] [--agents claude-code,codex]
  pair41 uninstall

Agent side (run by hooks; reads PAIR41_TOKEN and .pair41.json, else ~/.pair41/config.json):
  pair41 hook <event> [--agent claude-code|codex]   session-start, user-prompt-submit, pre-tool-use,
                                                    post-tool-use, stop, session-end
  pair41 doctor [--agent claude-code|codex]         check the setup and print fixes
  pair41 wait [--agent claude-code]                 wake an idle agent once when its partner needs it (run by
                                                    Claude Code's Stop hook; exits 2 with a wake-up line)
  pair41 bridge                                     push partner messages into Claude Code (off by default)
  pair41 run -- <command>                           run Codex in a wrapper that types "check pair" when idle

Server side (reads PAIR41_DATABASE_URL):
  pair41 serve                                      start the server
  pair41 migrate                                    apply database migrations (PAIR41_MIGRATION_DATABASE_URL if set)
  pair41 admin add-user <name> [--password <pw>]    create a user and print their agent token
  pair41 admin new-token <name>                     replace a user's agent token and print the new one
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      const { runHook } = await import('./hooks.ts');
      return runHook(rest);
    }
    case 'install': {
      const { runInstall } = await import('./install.ts');
      return runInstall(rest);
    }
    case 'uninstall': {
      const { runUninstall } = await import('./install.ts');
      return runUninstall();
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.ts');
      return runDoctor(rest);
    }
    case 'wait': {
      const { runWait } = await import('./wait.ts');
      return runWait(rest);
    }
    case 'bridge': {
      const { runBridge } = await import('./bridge.ts');
      return runBridge(rest);
    }
    case 'run': {
      const { runWrapper } = await import('./run.ts');
      return runWrapper(rest);
    }
    case 'serve': {
      const { startServer } = await import('../server/start.ts');
      await startServer();
      return new Promise<number>(() => {}); // runs until a signal stops it
    }
    case 'migrate':
    case 'admin': {
      const { runAdmin } = await import('./admin.ts');
      return runAdmin(command, rest);
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
