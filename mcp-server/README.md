# mcp-server

MCP (Model Context Protocol) server that lets AI clients read and manage a user's AWS resource watchlist, explore discovered AWS resources, and — most importantly — read Aura's evaluated permission diagnostics ("is it my code, or the cloud?"). Backed directly by the AuraCloud MongoDB (shared `utils` models).

## Tools

| Tool | Type | Description |
|---|---|---|
| `get_watchlist` | read | Current watchlist (resources + monitored IAM actions) for the acting user |
| `get_permission_status` | read | Aura's evaluated allow/deny per watched resource/action, with the exact deny reason and an overall health summary. Filters: `arn`, `action`, `status`, `includeDetails` (full policy-evaluation trace) |
| `check_theoretical_permission` | read | Live what-if evaluation (`arn`, `action`) for any discovered resource — watched or not — without touching the watchlist. Same evaluator and verdict vocabulary as the dashboard, computed on the spot from crawled data (needs Redis running) |
| `add_watchlist_resource` | write | Add a resource (`arn`, `actions[]`) — creates the watchlist if missing. The ARN must be a discovered resource: unknown ARNs are rejected (with a "did you mean" suggestion for near-misses); unknown action names are accepted but flagged in a `warnings` array |
| `remove_watchlist_resource` | write | Remove a resource by ARN (no validation — garbage that predates validation can always be removed) |
| `update_resource_actions` | write | Replace the actions array of a watched resource; unknown action names produce `warnings` |
| `list_aws_resources` | read | List discovered AWS resources. Filters: `resourceType`, `nameContains` (case-insensitive name search — resolves a human name to its exact ARN). Internal Aura identities are excluded |
| `get_resource_actions` | read | Valid IAM actions for a given ARN (same service-key mapping as the api-server) |

## Quickstart for teammates

```sh
git pull && nvm use && npm install && npm run build -w utils
echo 'export AURA_MCP_USER=<your-auracloud-email>' >> ~/.zshrc && exec zsh  # optional, defaults to admin@aura.com
```

Then open Claude Code in the repo root, approve the `auracloud` server when prompted (check with `/mcp`), and just talk to it — e.g. *"is anything blocked in my cloud right now?"*.

Your AuraCloud account must have a linked AWS user (done once in the UI); otherwise the server exits with a message telling you exactly that.

## Configuration

| Env var | Purpose |
|---|---|
| `MONGO_URI` | MongoDB connection string. Resolution order: process env → `mcp-server/.env` (not present by default) → `api-server/.env`, which is the symlink to the repo-root `.env` — so if you already run the stack, no extra setup is needed. |
| `MCP_USER_EMAIL` | Email of the AuraCloud customer this server instance acts as. `.mcp.json` sets it via `${AURA_MCP_USER:-admin@aura.com}`, so switch identity by exporting `AURA_MCP_USER` — never by editing `.mcp.json`. |

The user identity is resolved once at startup; restart the server (or reconnect via `/mcp`) after changing the linked AWS user.

## Running

```sh
# dev (tsx)
MCP_USER_EMAIL=admin@aura.com npm run dev -w mcp-server

# built
npm run build -w utils && npm run build -w mcp-server
MCP_USER_EMAIL=admin@aura.com node mcp-server/dist/index.js
```

The server speaks MCP over **stdio** — stdout is the protocol channel. All logging goes to stderr (`src/bootstrap.ts` reroutes `console.log`/`info`/`debug` before anything else loads).

Note: SDK 1.29 rejects `tools/call` requests that omit the spec-optional `arguments` field; `buildServer` installs a small normalization shim so bare calls (e.g. `get_permission_status` with no filters) work with any client.

## Remote (HTTP) mode

A second entry point serves MCP over **Streamable HTTP**, acting as an OAuth 2.1 **resource server** — no repo, `.env`, or Node setup on the client side, and no token for the user to handle:

```sh
npm run dev:http -w mcp-server
```

| Env var | Purpose |
|---|---|
| `MCP_HTTP_PORT` | Listen port (default 3001); endpoint is `POST /mcp`, liveness at `GET /healthz` |
| `JWT_SECRET` | **Required.** Same secret the api-server signs tokens with (picked up from `api-server/.env` via the fallback chain) |
| `MCP_SERVER_URL` | This server's public resource identifier (default `http://localhost:3001/mcp`). Must match what api-server advertises, or clients discover the wrong resource |
| `ISSUER_URL` | The api-server that issues tokens (default `http://localhost:${PORT}`, falling back to port 3000) |

The api-server is the authorization server: it registers clients, runs the consent screen, and mints the access tokens. This server only verifies them. Every request must carry `Authorization: Bearer <access token>`; tokens must carry the `auracloud-mcp` audience, so an api-server **login** JWT is rejected here — and an MCP access token is rejected by api-server's `requireAuth`. Identity is resolved **per request** from the token's `customerId`, so re-linking an AWS user applies immediately. The server is stateless (fresh transport per request): no sessions, horizontally scalable.

Discovery: `GET /.well-known/oauth-protected-resource` (also served at the RFC 9728 path-specific URL derived from `MCP_SERVER_URL`) names the authorization server, and every 401 carries `WWW-Authenticate: Bearer resource_metadata="<that URL>"` so a rejected client can find it.

Connect a client — no token, the browser consent flow supplies it:

```sh
claude mcp add --transport http auracloud http://localhost:3001/mcp
```

When testing with `curl`, send `Accept: application/json, text/event-stream` — the MCP SDK 406s without it (real MCP clients always send both).

## Connecting an AI client

The repo-root `.mcp.json` already registers the server for Claude Code (project-scoped). To register manually elsewhere:

```sh
claude mcp add auracloud \
  --env MCP_USER_EMAIL=you@company.com \
  -- npx tsx /path/to/AuraCloud/mcp-server/src/index.ts
```

For hand-crafted testing of individual tools:

```sh
npx @modelcontextprotocol/inspector -e MCP_USER_EMAIL=admin@aura.com npx tsx mcp-server/src/index.ts
```

## Slack notifications

A standalone worker (`src/slack/worker.ts`) DMs users about their **watchlist only** — unwatched resources never trigger anything:

- **Real-time alerts**: polls the Brain's verdicts (every `SLACK_ALERT_POLL_MS`, default 15s) and sends **one DM per changed resource**, listing every watched action that flipped (ALLOWED ↔ DENIED) with its deny reason — a burst of changes never spams the DM. Restarts seed silently — history is never replayed as alerts.
- **Daily morning summary**: cron `SLACK_DAILY_CRON` (default `0 8 * * *`, server-local time) with total/allowed/denied-or-risky counts plus per-resource statuses.

```sh
npm run start:all                          # includes the worker (label: slack)
npm run dev:slack -w mcp-server            # or the worker alone
npm run send-daily-summary -w mcp-server   # send the summary now, one-shot
```

Setup — two things, per environment:

1. `SLACK_BOT_TOKEN` in the shared `.env` (needs `chat:write`). The `.env` is **gitignored, so the token never arrives via git** — get it from a teammate over Slack/password manager. Without it the worker exits with a clear error and the rest of `start:all` is unaffected.
2. The recipient's Slack **user id** (`U…`, from profile → "Copy member ID" — **not** a `D…` DM-channel id) stored as `slackUserId` on the AWS `User` document their account is linked to:

```js
db.users.updateOne({ externalId: "<linkedAwsUserId>" }, { $set: { slackUserId: "U..." } })
```

⚠️ **Run one worker at a time.** Workers poll the shared MongoDB — two people running `start:all` with the token means every DM arrives twice. Agree who plays "notifier".

To see it work end-to-end: with the stack running, flip any permission on a **watched** resource in AWS → one grouped 🔔 DM per changed resource within ~30s (crawl + 10s Brain cycle + 15s poll); flip it back for the recovery DM. Changes made while the worker is down are never alerted retroactively (by design). Slack failures are logged and swallowed — they never interrupt DB writes or tool execution.
