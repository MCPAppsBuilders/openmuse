# Local conversation backend verification — 2026-10-17

Implemented in this working checkout; the pre-existing shopping integration was
preserved. This is the first single-server prototype, not an Intelligence protocol
implementation.

## Results

- TypeScript: server/domain/tests and Expo frontend pass `pnpm typecheck`.
- Web: Expo export succeeds. The demo bundle targets `http://127.0.0.1:18160`
  and contains the local conversation settings label.
- Test suite: 56 files, 490 tests validated across isolated file runs and a final
  targeted rerun. The initial isolated suite passed 486 tests; four existing lease
  tests failed because their partial `AgentService` config omitted `publicUrl`,
  required by the pre-existing shopping constructor. The fixture now supplies
  that URL; all four pass on rerun, together with the six local-backend tests.
- The six local tests verify database reopen, text/tool/activity/state replay,
  live reconnect without duplicates, disconnect lifetime, concurrency refusal,
  stop, repeated-run refusal, restart interruption, owner isolation, pagination,
  and the real CopilotKit client with two successive turns and reloads.
- The client transport test intercepts every outbound request and rejects any
  destination other than the test API. It exercises actual CopilotKit discovery,
  SSE run and connect handling, not a mocked runner response.
- A running HTTP sample API emitted nine AG-UI events, persisted them and replayed
  nine events with the same tool result. The API was stopped and restarted with
  the same data directory; the stable main-thread ID and saved tool result were
  verified again (`verifiedAfterServerRestart:true`).
- Targeted Biome checks and `git diff --check` pass.

The machine ran out of disk space during the first broad parallel test attempt.
Only scratch directories created by these test runs were removed. The suite was
then executed one file at a time with its temporary directory cleaned between
files. The incomplete parallel attempt is not counted as successful validation.

## Demo and evidence

- Web: `http://127.0.0.1:18161`
- API: `http://127.0.0.1:18160/api/health`
- Data: `artifacts/local-mini/` (fictional sample workspace)
- Test logs and HTTP smoke evidence: `artifacts/local-mini-verification/`
- Configuration: `THREAD_BACKEND=local`, `AGENT_BACKEND=sample`,
  `WORKSPACE_MODE=sample`, with no Intelligence project key and SDK telemetry
  disabled for this demo.

The demo uses scripted sample responses. No real model invocation is claimed.
Initial browser-control attempts failed. A subsequent check in the Codex in-app
browser succeeded: typed and sent a fictional message, observed the sample reply
and its task card, reloaded the page, and confirmed both remained visible. The
local conversation menu also loaded its saved threads. Screenshot:
`artifacts/local-mini-verification/browser-replay.png`.

The browser displays the worker/computer as offline because this sample demo
intentionally starts neither the background task worker nor a computer worker.
Native-device behavior has not been visually verified. See
[operating limits](LOCAL_THREADS.md) before using this backend outside a local
single-server prototype.
