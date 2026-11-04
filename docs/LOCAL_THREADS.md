# Local conversations: minimum independent backend

Set `THREAD_BACKEND=local` (the default). No Intelligence account, key, container,
Redis, or gateway is needed. The existing OpenMuse server stores AG-UI events in
its SQL Store and streams them through the CopilotKit SSE runtime.

```sh
THREAD_BACKEND=local pnpm dev
pnpm dev:web
```

For a model-free local trial, leave `WORKSPACE_MODE=sample` and
`AGENT_BACKEND=sample`. Sample answers are scripted; configuring local threads
does not configure a language model. Existing provider configuration still
applies when `AGENT_BACKEND=model`.

## Included

- Stable main conversation and separate side conversations.
- List, rename, archive, restore and paginate conversations.
- Durable journal of input, text, tool calls/results, activity and state events.
- Full replay through the CopilotKit `connectAgent` API, followed by the live
  tail if a reply is still running. The SQL sequence joins replay to live events
  without a gap or duplicate at that boundary.
- Persistence before publication; detaching a browser does not cancel its run.
- One active run per owner/thread; explicit stop and duplicate-run refusal.
- Owner isolation for metadata, journal, run, connect and stop.
- On server startup, unfinished chat runs are marked interrupted. Saved tool
  results are retained and tools are never automatically executed again.

## Local API

All routes require the normal OpenMuse Bearer session. Owner identity is resolved
on the server; it cannot be supplied in a request body.

| Endpoint | Use |
| --- | --- |
| `GET /api/main-thread` | Provision/load the stable main thread |
| `GET /api/local-threads?limit=20&cursor=…` | Creation-ordered page, including archived threads |
| `PATCH /api/local-threads/:id` | `{name}` or `{archived:true/false}` |
| `GET /api/local-threads/:id/events?after=0` | Durable entries and sequence cursor for inspection |
| `GET /api/copilotkit/info` | CopilotKit runtime negotiation (`mode:sse`) |
| `POST /api/copilotkit/agent/default/run` | Standard AG-UI run input |
| `POST /api/copilotkit/agent/default/connect` | CopilotKit reconnect/full replay |
| `POST /api/copilotkit/agent/default/stop/:threadId` | Stop the active reply |

Journal entries live in the existing SQL `records` table, scoped by owner and
thread, with an append-only sequence. Metadata updates use SQL compare-and-swap.
The generic CopilotKit local-dev thread endpoints, including global clear, are
blocked. The UI uses the authenticated local metadata API instead.

## Operating boundary

This first version supports **one API process per database**. It keeps active
agents and live subscriptions in that process. It loads a thread's full journal
for replay; production-sized retention, bounded replay and snapshots are future
work. Use PGlite locally; the existing Postgres Store also works with the same
single-process boundary. Do not deploy multiple replicas against this database.

Stopping or crashing the server interrupts the current chat execution. It does
not checkpoint arbitrary model/tool execution. The separate durable task engine
retains its existing behavior. If a journal write fails, the reply reports an
error and the thread remains locked until startup recovery.

The active thread list refreshes when opened/refreshed; no cross-device push of
thread metadata is implemented. Reconnection uses full AG-UI replay rather than
a browser-managed Last-Event-ID cursor. Existing Intelligence history is not
imported: local storage begins empty while preserving the main-thread mapping.

To retain the original cloud backend, set `THREAD_BACKEND=intelligence` and supply
`CPK_INTELLIGENCE_API_KEY`. Both paths remain selectable. This local implementation
does not implement the Intelligence HTTP/Phoenix protocol.

## Checks

```sh
pnpm exec tsx --import ./tests/setup.ts --test --test-concurrency=1 tests/local-threads.test.ts tests/config.test.ts tests/rich-threads.test.ts
pnpm typecheck
pnpm --dir apps/mobile build:web
```

For an HTTP smoke test against a running local sample API (port 18160 by default):

```sh
node scripts/verify-local-chat.mjs
# Restart the API, keeping the same DATA_DIR, then:
node scripts/verify-local-chat.mjs --replay-only
```

This script creates a fictional sample conversation and checks its saved tool
result after replay. It writes sanitized evidence under `artifacts/` and never
saves session tokens. Set `MINI_API_URL` for another local port.

The local tests exercise disk reopen, rich replay, active-run reconnect, stop,
duplicate-run refusal, restart recovery, ownership and the actual CopilotKit
client transport. Rendered browser verification is recorded separately from
these API/SDK checks.
