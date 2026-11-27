# Pair41

Pair41 lets your coding agent pair with your teammate's coding agent, whichever agent each of you uses (Claude Code, Codex, or anything that speaks MCP). It is for two P41 developers building parts of the same feature in parallel, each with their own agent and their own PR: the agents share contracts on a versioned board, ask each other instead of guessing, and see what the other side is doing, while both humans watch it live.

![The pair room: the two agents drawn in 3D with the bond between them, a status strip saying what is your turn, each side's agent, model and activity, the thread, open questions and the board](docs/screenshots/pair-room.png)

> Hackathon build. The plan, the build report and the decision log (`docs/PLAN.md`, `docs/BUILD_REPORT.md`, `docs/QUESTIONS.md`) are kept on the team's machines, not in this repo; section references such as "PLAN.md §8.4" point into them.

## Run it locally

Prerequisites: Node 22.18 or newer (Node runs the TypeScript source directly; there is no build step), git, and a running Postgres server with a database for Pair41.

```bash
scripts/init.sh
export PAIR41_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/pair41'
scripts/dev.sh
```

Use your own connection URL. `scripts/dev.sh` applies the schema before starting the server. If you have a separate migration role, set `PAIR41_MIGRATION_DATABASE_URL` as well.

Open http://localhost:8765: logged out, the first page is the landing page, with the log-in card in the hero ("Create account" signs you up). Keep the agent token it shows you after sign-up.

## How pairing works

Pairs are between two people, and only by agreement:

1. **Ask.** On Home, pick a teammate and ask them to pair on a feature (or tell your agent "use Pair41 to ask sam to pair on due dates").
2. **Agree.** They accept on their Home page (or tell their agent to). Until both of you have agreed, nothing is paired.
3. **Join.** Each pair has a code, such as `amber-otter-42`, on its page. Each of you tells your own agent "join Pair41 pair amber-otter-42". Any agent that speaks MCP can join: Claude Code, Codex, Cursor and others. The code only puts an agent of yours on your own side, so it is not a secret that has to be guarded.
4. **Work.** Once both agents have joined, they share a board (contracts, decisions, progress), ask each other questions and see what the other side is doing. You both watch it in the pair room.

Sessions are never listed and nobody types a session id. There are no solo pairs: one person splitting work between their own agents is better served by one agent with subagents.

## The pages

| Landing                                                    | Log in and sign up                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| ![Landing page](docs/screenshots/landing.jpg)              | ![Log in](docs/screenshots/login.png)                                     |
| **Home**                                                   | **A teammate's page**                                                     |
| ![Home](docs/screenshots/home.png)                         | ![A teammate](docs/screenshots/teammate.png)                              |
| **Conversation log**                                       | **Analytics**                                                             |
| ![Conversation log](docs/screenshots/conversation-log.png) | ![Analytics](docs/screenshots/analytics.png)                              |
| **Connect your agent**                                     | **Light theme** (pair room)                                               |
| ![Connect your agent](docs/screenshots/connect.png)        | ![The pair room in the light theme](docs/screenshots/pair-room-light.png) |

- **Landing and log in** (`/login`, logged out): a scroll-driven 3D page (the two agents as particle clouds joined by a bridge), with the log-in and sign-up card in the hero, how it works, what you get and a short FAQ.
- **Needs you**, in the top bar of every page: a count of what is your turn (a pair request, a message waiting for your approval, a question your agent deferred to you, an agent to join or resume, unread messages to fetch, news from your partner), then what is your agent's turn (an open question, a file both agents edited) and what waits on your partner (an overdue question, with a **Nudge** button). It can raise browser notifications while a Pair41 tab is open. Every command in it has a copy button.
- **Home** shows Needs you first, then your current pair, requests and your teammates (online or when last seen), with a live view of you and the people around you.
- A **teammate's page** has "Ask to pair" and the history of every pair you two had.
- The **pair room** opens with the live view (each message travels along the beam between the two agents as it arrives), then a status strip with the pair's state, both agents (working, idle or not running, model, activity) and your next step, then the thread, open questions, the board and the feed. "End pair" (or "Withdraw request") is in the header; whoever ends the pair is recorded, so the other person is told.
- **Conversation log** (`/pairs/<id>/log`) shows everything in order: messages, what each person asked their agent, what each agent concluded, commits and board changes, and downloads as markdown.
- **Connect your agent** (`/connect`): your server address, the install commands for Claude Code and Codex, and a button to replace your agent token.
- **Analytics** (`/analytics`): impact (time saved estimate, interruptions avoided, edit clashes caught, helpful pairs), questions, shared context and adoption. Definitions: `docs/specs/analytics.md` and `docs/specs/metrics.md`.

Dark first; the switch in the top bar gives a light theme. The 3D views fall back to 2D without WebGL 2, hold still with reduced motion, and have a pause button. Add `?agents=orb` to any page to draw the agents as orbs instead of atoms.

## Connect your agents

**Claude Code: the Pair41 plugin** (recommended; no repo needed once it is in P41's plugin library on claude.ai, which waits until the hackathon is judged). In Claude Code run `/plugin`, install `pair41`, and enter the server and your agent token when it asks (the token goes to your keychain; after a new token, update it with `/plugin manage`). It holds the MCP server, the hooks and the `pair41` skill, so any session you start, in any folder, can join a pair when you give it the pair code. Its waiter wakes an idle Claude: after each turn, `pair41 wait` waits in the background, and when your partner asks a question, answers one or changes a contract while your Claude is idle, it wakes Claude once to call `check_messages` (at most 10 times between two prompts from you). It needs Node 22.18 or newer. `/pair41:doctor` checks the setup and says how to fix what is wrong. `PAIR41_OFF=1` turns Pair41 off for one session.

- Try it before it is published: `scripts/build-plugin.sh`, then in Claude Code `/plugin marketplace add <repo>/agent-kit/plugin` and `/plugin install pair41@pair41-local`.
- Publish it: `scripts/build-plugin.sh <folder outside the repo>` (the built files are git-ignored here, and publishing leaves git-ignored files out), then ask Claude Code to publish that folder to the organization. Bump `version` in `agent-kit/plugin/pair41/.claude-plugin/plugin.json` for each new publish.

**Codex**, once from a clone:

```bash
bin/pair41 install --agents codex --token p41_... --server http://localhost:8765
```

This sets Pair41 up for your user: the MCP server, the hooks and the `pair41` skill for Codex (Codex Desktop included), and `~/.pair41/config.json` with your server and token. Sessions that were already running need one restart (`codex resume <id>`), and Codex asks you to trust the new hooks once (`/hooks`). Run it again after pulling a new Pair41, so the skill is up to date. `bin/pair41 uninstall` removes it. Without `--agents` it sets up Claude Code as well (with the waiter), for Claude Code from a clone instead of the plugin; use one or the other, not both, or every hook runs twice.

**Any other MCP agent:** add the MCP server `http://<server>/mcp` with the header `Authorization: Bearer p41_...`. Without the hooks your agent sees partner messages when it calls a Pair41 tool, so tell it "check pair" now and then.

**Or per repo**, with the connect scripts:

1. Put your token in your shell profile: `export PAIR41_TOKEN=p41_...` (lost it? "Connect your agent" → Regenerate).
2. In the repo folder your agent runs in:

```bash
agent-kit/connect-claude.sh --project todo-app path/to/repo   # Claude Code: MCP server, hooks, pair41 skill
agent-kit/connect-codex.sh  --project todo-app path/to/repo   # Codex: .codex/config.toml, .codex/hooks.json, skill
```

3. Check it from that folder: `bin/pair41 doctor --agent claude-code` (or `--agent codex`). Codex hooks need trusting once with `/hooks` inside Codex.

Add `--server https://pair41.example` to point at a shared server. `connect-claude.sh --with-bridge` also starts the bridge, which pushes partner messages into a running Claude Code session; it is off by default and only for once P41 agrees (PLAN.md §6.6).

To nudge an idle Codex automatically: `bin/pair41 run -- codex` types "check pair" when a partner message arrives and Codex is idle. Idle Claude Code sessions are woken by the waiter that `pair41 install`, the plugin and `connect-claude.sh` set up (see `docs/specs/protocol.md`, "Wake").

## How it works

```
 Amish's laptop                                   Sam's laptop
 ┌──────────────────────────────┐          ┌──────────────────────────────┐
 │ Claude Code session          │          │ Codex session                │
 │  ├─ MCP client ──────────────┼─┐      ┌─┼─ MCP client                  │
 │  ├─ inbox socket ◄─┐         │ │      │ │  hooks (PostToolUse, Stop) ──┼─┐
 │  └─ hooks          │         │ │      │ │                              │ │
 │ Pair41 bridge ─────┘─────────┼┐│      │ │ Browser: Pair41 page ────────┼┐│
 │ Browser: Pair41 page ────────┼┼┤      │ └──────────────────────────────┘││
 └──────────────────────────────┘││      │                                 ││
                    WebSocket    ││ HTTP │ (MCP)                   HTTP    ││
                    (push)       ▼▼      ▼                                 ▼▼
                         ┌─────────────────────────────────────────────────┐
                         │ Pair41 server                                   │
                         │  /mcp     MCP tools for every agent             │
                         │  /bridge  WebSocket for local bridges (push)    │
                         │  /api     small JSON API for hooks              │
                         │  /        web pages, /events live feed          │
                         │  Postgres                                       │
                         └─────────────────────────────────────────────────┘
```

- **Server** (`src/server`, `src/services`, `src/store`): Fastify, the MCP TypeScript SDK (stateless Streamable HTTP at exactly `/mcp`), Kysely on Postgres with SQLite support for local use, server-rendered Eta pages with HTMX and server-sent events. The 3D views use Three.js, GSAP ScrollTrigger and Lenis, served from `/static/vendor/<package>-<version>/` through an import map, so there is still no build step; static files are read and gzipped once at boot.
- **Agent side** (`src/cli`, `agent-kit`): the `pair41` command run by Claude Code and Codex hooks, `pair41 doctor`, the optional bridge, the Codex wrapper, connect scripts, the `pair41` skill and the Claude Code plugin. It uses Node built-ins only.
- Specs: `docs/specs/mcp-tools.md`, `protocol.md`, `web.md`, `analytics.md`, `metrics.md`. Agent conventions: `AGENTS.md`.

### Endpoints

| Path                                                                                             | What                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp`                                                                                      | The MCP tools (`pair_status`, `who_is_online`, `request_pair`, `respond_to_pair`, `join_pair`, `send_message`, `check_messages`, `get_message`, `acknowledge`, `defer`, `wait_for_reply`, `board_update`, `board_read`, `set_activity`, `end_pair`). Bearer agent token |
| `POST /api/hooks/<event>`, `GET /api/me`, `GET /api/unread`, `GET /api/wait`                     | For the `pair41` CLI (`/api/wait` is held until the session has something worth waking it for). Bearer agent token                                                                                                                                                      |
| `GET /bridge`                                                                                    | WebSocket for the optional bridge                                                                                                                                                                                                                                       |
| `/login`, `/connect`, `/lobby`, `/people/<name>`, `/pairs/<id>`, `/pairs/<id>/log`, `/analytics` | Web pages (login cookie). Unknown pages, and pairs or people you cannot see, get a 404 page                                                                                                                                                                             |
| `GET /needs`, `POST /pairs/<id>/nudge`                                                           | The Needs you list (HTMX partial, polled every 10 s) and nudging your partner                                                                                                                                                                                           |
| `GET /static/...`                                                                                | Styles, scripts and vendor packages, cached by content hash or version                                                                                                                                                                                                  |
| `GET /events?pair=<id>`                                                                          | Server-sent events for the pair room                                                                                                                                                                                                                                    |
| `GET /api/analytics?window=7d\|all[&project=]`                                                   | Analytics as JSON (cookie or agent token): counts only, never pair content                                                                                                                                                                                              |
| `GET /live`, `GET /ready`                                                                        | Health probes, unauthenticated                                                                                                                                                                                                                                          |

## The `pair41` command

| Command                                                                           | What it does                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pair41 hook <event> --agent <kind>`                                              | Run by the agent's hooks: `session-start`, `user-prompt-submit`, `pre-tool-use`, `post-tool-use`, `stop`, `session-end`. Never fails the agent                                                                                                                            |
| `pair41 doctor --agent <kind>`                                                    | Checks the token, the server, the MCP endpoint and how the agent has Pair41 (for Claude Code: the plugin, `pair41 install` or `connect-claude.sh`, and two at once is a problem), and prints a fix for each problem. With the plugin, run `/pair41:doctor` in Claude Code |
| `pair41 wait --agent <kind>`                                                      | Run by Claude Code's Stop hook in the background: exits 2 with a wake-up line when the partner needs this idle session, which wakes Claude                                                                                                                                |
| `pair41 bridge`                                                                   | Started by Claude Code's SessionStart hook when the bridge is on                                                                                                                                                                                                          |
| `pair41 run -- <command>`                                                         | Runs Codex in a wrapper that types "check pair" when a message arrives and it is idle                                                                                                                                                                                     |
| `pair41 serve`, `pair41 migrate`                                                  | Start the server; apply database migrations                                                                                                                                                                                                                               |
| `pair41 admin add-user <name> [--password <pw>]`, `pair41 admin new-token <name>` | Create a user or replace a token, printing the agent token                                                                                                                                                                                                                |

## Tests and checks

```bash
scripts/validate.sh          # lint, format check, type check, tests, Semgrep: the same script CI runs
npx vitest run               # tests only (SQLite)
PAIR41_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/validate.sh   # also on Postgres
```

There is one test per behaviour in PLAN.md §8.4 (`tests/`), through the real `/mcp` endpoint, a temporary database and the real CLI. Nothing of ours is mocked; the outside world (Claude Code's inbox socket, the Codex CLI) is faked.

## Try it: two developers on one machine

Two clones of a small public app stand in for two machines, and a second Pair41 user stands in for your teammate. [docker/getting-started-app](https://github.com/docker/getting-started-app) is Docker's sample todo app (MIT): an Express + SQLite API in `src/routes` and `src/persistence`, and one React page in `src/static/js/app.js`, so a feature splits cleanly into a backend half and a frontend half.

```bash
mkdir -p ~/Documents/pair41-machines/claude ~/Documents/pair41-machines/codex
git clone https://github.com/docker/getting-started-app ~/Documents/pair41-machines/claude/todo-app
git clone https://github.com/docker/getting-started-app ~/Documents/pair41-machines/codex/todo-app
```

Sign up a second user (say `sam`) in another browser profile, then give sam's agent its own config, so it really is sam on "the other machine":

```bash
unset PAIR41_TOKEN       # so nothing falls back to your own token
export CODEX_HOME=~/Documents/pair41-machines/codex/.codex PAIR41_HOME=~/Documents/pair41-machines/codex/.pair41
bin/pair41 install --agents codex --token p41_<sam's token>
codex login                       # once, for this CODEX_HOME
cd ~/Documents/pair41-machines/codex/todo-app && codex
```

Claude Code runs as you, from `~/Documents/pair41-machines/claude/todo-app`, with your normal install. Then: ask sam to pair on Home, accept as sam, and tell each agent "join Pair41 pair <code>".

## Configuration

Server (environment variables; nothing is baked into the image):

| Variable                                                           | Default                                  | What it is                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`                                                             | `8765` (`8080` in the container)         | HTTP port                                                                                            |
| `HOST`                                                             | `127.0.0.1` (`0.0.0.0` in the container) | Listen address                                                                                       |
| `PAIR41_DATABASE_URL`                                              | Required                                 | Postgres connection URL for the app user. Explicit `sqlite:<path>` URLs also work locally.           |
| `PAIR41_MIGRATION_DATABASE_URL`                                    | –                                        | Used by `pair41 migrate` only (the migration user)                                                   |
| `PAIR41_DATABASE_SSL`                                              | `false`                                  | `true` (work-1): TLS that checks the server's certificate and host name. `false`: the URL decides    |
| `PAIR41_PUBLIC_URL`                                                | –                                        | e.g. `https://pair41.dev.apps.particle41.ninja`: secure cookies, trusted proxy headers, allowed host |
| `PAIR41_ALLOWED_HOSTS`                                             | –                                        | Extra host names allowed on `/mcp`, `/api` and `/bridge` (comma separated)                           |
| `PAIR41_INVITE_CODE`                                               | –                                        | When set, sign-up needs this code                                                                    |
| `LOG_LEVEL`                                                        | `info`                                   | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`                                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, other `OTEL_*` | off, `pair41`                            | OpenTelemetry tracing over OTLP (start with `node --import ./src/server/telemetry.ts`)               |

Agent side: `PAIR41_TOKEN` (your agent token), `PAIR41_HOME` (logs and the bridge's and waiter's pid files, default `~/.pair41`), `PAIR41_SERVER` and `PAIR41_PROJECT` (override `.pair41.json`).

### Log format

One JSON object per line on stdout: `time` (RFC 3339 with milliseconds), `severity_text` and `severity_number` (OpenTelemetry levels), `service`, `msg`, the request id (`reqId`), and `trace_id`/`span_id` when tracing is on. Hooks log to `~/.pair41/hooks.log`.

## Deploying to work-1

Pair41 runs on the `work-1` EKS cluster in namespace `team-5` and is public at https://pair41.dev.apps.particle41.ninja through the shared `default` ALB.

- Image: `docker build -t pair41 .` (Node 22, non-root, exec-form entrypoint, port 8080). It ships the AWS RDS certificate authorities (`infra/rds-ca-bundle.pem`, from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) and trusts them through `NODE_EXTRA_CA_CERTS`, so with `PAIR41_DATABASE_SSL=true` (the chart's `databaseSsl`) the app and the migration Job verify RDS's certificate; `ssl*` parameters in the URL are then ignored. Refresh the file from that URL when AWS adds a CA. CI builds and scans it on every pull request; on `main` it pushes it to ECR as `878386473932.dkr.ecr.us-east-1.amazonaws.com/pair41/pair41:<commit sha>` (and `latest`).
- Database: `infra/terraform` creates an RDS Postgres (`db.t4g.micro`) that only the cluster's pods reach, and its dbinit Lambda sets up the separate app and migration users that `deploy/postgres-users.sql` describes. Terraform writes the URLs to Parameter Store (`/hackathon/team-5/pair41/database-url` and `.../migration-database-url`, plus a random `.../invite-code`); nothing to fill in by hand. Migrations run as their own process, `node src/cli/main.ts migrate` (the chart's pre-install Job), never at start. Pair41 has been deployed, so schema changes are new migrations (`002_attention` adds who ended a pair, when each person last opened a pair room, and nudges).
- ALB: `infra/terraform` also creates the `pair41` ip target group (HTTP 8080, health check `/ready`), the host rule on the ALB's 443 listener and the Route 53 alias. `.github/workflows/infra.yml` plans it on pull requests and applies it on a merge to `main`.
- Kubernetes: `deploy/helm/pair41` (Parameter Store values through `ExternalSecret`s under `/hackathon/team-5/pair41/`, the `app` service account that team-5's Pod Identity association uses, a migration Job, the Deployment with `/live` and `/ready` probes, a Service, and a `TargetGroupBinding` that registers the pod in the target group).
- Shutdown: on `SIGTERM`/`SIGINT` the server fails `/ready`, ends live streams, drains requests, flushes traces, closes the database and exits 0.

Order:

1. Particle41/aws-infra#72 (the ECR repository and this repository's CI access) is merged and applied.
2. Merge the change that adds `infra/terraform` and the image push.
3. CI pushes the image for that commit.
4. The `infra` workflow applies the database, its Parameter Store values, the target group, listener rule and DNS record; its output `target_group_arn` is the ARN for the next step. The invite code: `aws ssm get-parameter --with-decryption --name /hackathon/team-5/pair41/invite-code`.
5. Install or upgrade the release:

   ```bash
   helm upgrade --install pair41 deploy/helm/pair41 -n team-5 \
     --set image.tag=<commit sha> \
     --set targetGroupBinding.arn=<target_group_arn>
   ```

The `TargetGroupBinding` carries `helm.sh/resource-policy: keep`: `helm uninstall` leaves it, so delete it by hand (`kubectl -n team-5 delete targetgroupbinding pair41`) when the app goes away for good.

## Quick metrics

From `scripts/bench.sh` on a MacBook (local server, SQLite, 30 runs each). Time to answer comes from real use: `/api/analytics`.

| Measure                  | median ms | p90 ms |
| ------------------------ | --------- | ------ |
| Login page load          | 0.3       | 0.4    |
| Lobby page load          | 0.7       | 1.0    |
| Pair room page load      | 0.7       | 1.0    |
| `send_message` → receipt | 1.5       | 2.3    |
| `check_messages`         | 1.3       | 2.6    |

## Credits

Pair41, which pairs two Claude Code users on one network. We borrowed several of its ideas: separate delivery states, sanitising partner text as data, unread notices only when something is new, hooks that brief and record, and no silent overwrites (PLAN.md §6.12).
