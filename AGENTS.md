# AGENTS.md

Conventions and gotchas for agents working on Pair41. `CLAUDE.md` is a symlink to this file; never make it a separate file. What Pair41 is and how it works: `README.md` and `docs/specs/`; the plan, build report and decision log are in `docs/PLAN.md`, `docs/BUILD_REPORT.md` and `docs/QUESTIONS.md` when you have them locally (they are not committed).

## Commands

- `scripts/init.sh`: install dependencies.
- `scripts/validate.sh`: everything CI runs (lint, format check, type check, tests, Semgrep). Run it before every commit.
- `scripts/dev.sh`: migrate the database configured in `PAIR41_DATABASE_URL` and start the server on `localhost:8765`. Use Postgres for development and deployment.
- `bin/pair41 ...`: the CLI (hooks, doctor, admin, migrate, serve, bridge, run).

## Conventions

- TypeScript, strict, run directly by Node (type stripping); there is no build step. So: import local files with the `.ts` extension, use `import type` for types, and no enums, namespaces or constructor parameter properties (`erasableSyntaxOnly`).
- No `any`. If one is unavoidable, keep it local and say why in a comment.
- Keep code small and plain: one file per concern, functions over classes, no frameworks beyond the stack in PLAN.md §12.
- Layout: `src/server` (HTTP, MCP, web, bridge socket), `src/services` (all logic, talks to the store), `src/store` (Kysely schema and migrations), `src/cli` (the `pair41` command; hooks and bridge use Node built-ins only, so they can ship in the plugin), `src/shared` (code both sides use).
- Times are epoch milliseconds (numbers). Booleans are stored as 0/1. Both work the same on SQLite and Postgres.
- The schema is in `src/store/migrations.ts`. Pair41 has been deployed: never edit a migration that has shipped; add a new one (`002_attention` is the latest).
- Browser code is plain ES modules in `src/server/web/static/` (the 3D layer in `static/space/`); vendor packages (Three.js, GSAP, Lenis) are served by `src/server/web/assets.ts` through an import map. Keep it buildless.
- Specs first: change `docs/specs/` before changing behaviour.

## Tests

- Only the behaviours listed in PLAN.md §8.4, one test file each, written before the code. Nothing else gets a test.
- Tests go through the real `/mcp` endpoint, a temporary SQLite file and the real CLI (`bin/pair41`). Never mock our own code. Helpers are in `tests/helpers.ts`.
- `PAIR41_TEST_POSTGRES_URL=postgres://...` runs the same tests on Postgres (each test file gets its own schema). CI does both.

## Gotchas

- **Never write to a real Claude Code inbox socket.** Tests and scripts that start `pair41` child processes must use `cleanEnv()` from `tests/helpers.ts` (or `unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN` in shell), because the session running them may have its own socket in the environment.
- Mount MCP at exactly `/mcp`. A `/mcp` → `/mcp/` redirect breaks clients behind the ALB.
- DNS-rebinding protection is on: the allowed hosts (bare host and host with port) come from `PAIR41_ALLOWED_HOSTS` and `PAIR41_PUBLIC_URL`. Test `/mcp` with the real Host header.
- MCP is stateless: identity comes from the bearer token, `X-Pair-Agent`, `X-Pair-Project` and the `_session` tool argument on every request. Nothing is kept per connection.
- `wait_for_reply` stays under 45 s and stops when the client disconnects.
- Hooks are short-lived processes: read JSON from stdin, print only the JSON result on stdout, log to `$PAIR41_HOME/hooks.log`, and never exit non-zero.
- The inbox socket is a Unix socket: connect when the message is ready, write the auth line and the message line each ending in `\n`, then close (Claude Code drops idle connections after 30 s).
- Postgres returns `bigint` and `count(*)` as strings; `src/store/db.ts` sets a type parser so they come back as numbers.
- Migrations never run at boot. `pair41 migrate` runs them, with `PAIR41_MIGRATION_DATABASE_URL` when set.
- Agent configs for testing go only in temporary folders. Never touch `~/.claude`, `~/.codex` or the repo root's `.claude/` (`pair41 install` writes the user configs only when a person runs it).
