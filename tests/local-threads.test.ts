import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { lastValueFrom, type Observable, of, ReplaySubject, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/local-threads.ts";

let directory: string, db: Store;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
const input = (threadId: string, runId = `${threadId}-run`): RunAgentInput => ({
  threadId,
  runId,
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: `${runId}-user`, role: "user", content: "Show me the result" }],
});
const collect = (stream: Observable<BaseEvent>) => lastValueFrom(stream.pipe(toArray()));
class CompleteAgent extends AbstractAgent {
  run(i: RunAgentInput) {
    return of<BaseEvent[]>(
      { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: `${i.runId}-answer`, role: "assistant" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `${i.runId}-answer`,
        delta: "Saved answer",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: `${i.runId}-answer` },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: `${i.runId}-tool`,
        toolCallName: "show_card",
        parentMessageId: `${i.runId}-answer`,
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: `${i.runId}-tool`, delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: `${i.runId}-tool` },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: `${i.runId}-tool`,
        messageId: `${i.runId}-result`,
        content: '{"title":"Persisted card"}',
        role: "tool",
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: { selected: "card" } },
      { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/confirmed", value: true }] },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `${i.runId}-activity`,
        activityType: "progress",
        content: { done: true },
      },
      { type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId },
    );
  }
}
class StreamingAgent extends AbstractAgent {
  readonly source = new ReplaySubject<BaseEvent>();
  run() {
    return this.source.asObservable();
  }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a durable event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("local replay retains text, tool cards, activity, input and patched state across database reopen", async () => {
  const path = join(directory, "reopen");
  let disk = await createStore({ dataDir: path });
  let threads = new LocalThreads(disk);
  const i = input("persist");
  await collect(
    threads.runner("alice").run({ threadId: i.threadId, input: i, agent: new CompleteAgent() }),
  );
  await threads.update("alice", i.threadId, { name: "Saved topic", archived: true });
  await disk.close();
  disk = await createStore({ dataDir: path });
  try {
    threads = new LocalThreads(disk);
    const events = await collect(threads.runner("alice").connect({ threadId: i.threadId }));
    assert.ok(
      events.some(
        (e) => e.type === EventType.TOOL_CALL_RESULT && e.content === '{"title":"Persisted card"}',
      ),
    );
    assert.ok(events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT));
    assert.ok(
      events.some(
        (e) =>
          e.type === EventType.STATE_SNAPSHOT &&
          JSON.stringify(e.snapshot).includes('"confirmed":true'),
      ),
    );
    assert.ok(JSON.stringify(events).includes("Saved answer"));
    assert.ok(JSON.stringify(events).includes(i.messages[0].id));
    const thread = await threads.get("alice", i.threadId);
    assert.equal(thread.name, "Saved topic");
    assert.equal(thread.archived, true);
    assert.equal(thread.running, false);
    await threads.update("alice", i.threadId, { archived: false });
    assert.equal((await threads.get("alice", i.threadId)).archived, false);
  } finally {
    await disk.close();
  }
});

test("disconnect leaves the run alive; reconnect joins durable replay and live tail without duplicates", async () => {
  const threads = new LocalThreads(db),
    runner = threads.runner("alice"),
    agent = new StreamingAgent();
  const i = input("stream");
  const subscription = runner.run({ threadId: i.threadId, input: i, agent }).subscribe();
  agent.source.next({ type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId });
  agent.source.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "stream-answer",
    role: "assistant",
  });
  agent.source.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "stream-answer",
    delta: "Before ",
  });
  await until(async () => (await threads.entries("alice", i.threadId)).length === 3);
  subscription.unsubscribe();
  assert.equal(await runner.isRunning({ threadId: i.threadId }), true);
  const refused = await collect(
    runner.run({ threadId: i.threadId, input: input("stream", "second"), agent }),
  );
  assert.equal(refused[0].type, EventType.RUN_ERROR);
  const reconnected = collect(runner.connect({ threadId: i.threadId }));
  agent.source.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "stream-answer",
    delta: "after",
  });
  agent.source.next({ type: EventType.TEXT_MESSAGE_END, messageId: "stream-answer" });
  agent.source.next({ type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId });
  agent.source.complete();
  const replay = await reconnected;
  const text = replay
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => e.delta)
    .join("");
  assert.equal(text, "Before after");
  assert.equal(replay.filter((e) => e.type === EventType.RUN_STARTED).length, 1);
  assert.equal(replay.filter((e) => e.type === EventType.RUN_FINISHED).length, 1);
});

test("stop finishes a partial run, and a duplicate run ID never executes tools again", async () => {
  const threads = new LocalThreads(db),
    runner = threads.runner("alice"),
    agent = new StreamingAgent();
  const i = input("stop");
  const result = collect(runner.run({ threadId: i.threadId, input: i, agent }));
  agent.source.next({ type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId });
  await until(async () => (await threads.entries("alice", i.threadId)).length > 0);
  assert.equal(await runner.stop({ threadId: i.threadId, runId: "older" }), false);
  assert.equal(await runner.stop({ threadId: i.threadId, runId: i.runId }), true);
  await result;
  assert.equal((await threads.get("alice", i.threadId)).running, false);
  const refused = await collect(
    runner.run({ threadId: i.threadId, input: i, agent: new CompleteAgent() }),
  );
  assert.equal(refused[0].type, EventType.RUN_ERROR);
  assert.match(String(refused[0].message), /already been accepted/);
});

test("restart closes an interrupted journal explicitly and never re-executes the agent", async () => {
  const threads = new LocalThreads(db);
  await threads.ensure("restart-owner", "interrupted");
  await db.compareAndSwap(
    "restart-owner",
    "local-chat-threads",
    "interrupted",
    {},
    { running: true, runId: "lost-run" },
  );
  await threads.append("restart-owner", "interrupted", "lost-run", 1, {
    type: EventType.RUN_STARTED,
    threadId: "interrupted",
    runId: "lost-run",
  });
  await threads.append("restart-owner", "interrupted", "lost-run", 2, {
    type: EventType.STATE_SNAPSHOT,
    snapshot: { receipt: "saved-before-crash" },
  });
  await threads.recoverInterrupted();
  const events = (await threads.entries("restart-owner", "interrupted")).map((e) => e.event);
  assert.ok(
    events.some(
      (e) => e.type === EventType.RUN_ERROR && String(e.message).includes("Server restarted"),
    ),
  );
  assert.ok(JSON.stringify(events).includes("saved-before-crash"));
  assert.equal((await threads.get("restart-owner", "interrupted")).running, false);
  const count = events.length;
  await threads.recoverInterrupted();
  assert.equal((await threads.entries("restart-owner", "interrupted")).length, count);
});

test("local metadata and runtime endpoints enforce authenticated ownership and stable pagination", async () => {
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    threadBackend: "local",
    taskWorkerEnabled: false,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  for (const owner of ["api-alice", "api-bob"])
    await db.put("system", "sessions", {
      id: createHash("sha256").update(owner).digest("hex"),
      owner,
      expiresAt: Date.now() + 60000,
    });
  const headers = (owner = "api-alice") => ({
    Authorization: `Bearer ${owner}`,
    "Content-Type": "application/json",
  });
  try {
    assert.equal((await server.app.request("/api/main-thread")).status, 401);
    const main = await (
      await server.app.request("/api/main-thread", { headers: headers() })
    ).json();
    const again = await (
      await server.app.request("/api/main-thread", { headers: headers() })
    ).json();
    assert.equal(main.threadId, again.threadId);
    const i = input("private-card");
    await collect(
      server.localThreads
        .runner("api-alice")
        .run({ threadId: i.threadId, input: i, agent: new CompleteAgent() }),
    );
    for (const path of [
      "/api/local-threads/private-card/events",
      "/api/copilotkit/agent/default/connect",
      "/api/copilotkit/agent/default/stop/private-card",
    ]) {
      const post = path.includes("/agent/");
      const response = await server.app.request(path, {
        headers: headers("api-bob"),
        ...(post ? { method: "POST", body: JSON.stringify(i) } : {}),
      });
      assert.equal(response.status, 404, path);
    }
    const mutate = await server.app.request("/api/local-threads/private-card", {
      method: "PATCH",
      headers: headers("api-bob"),
      body: '{"name":"stolen"}',
    });
    assert.equal(mutate.status, 404);
    assert.equal(
      (
        await server.app.request("/api/copilotkit/threads/clear", {
          method: "POST",
          headers: headers(),
        })
      ).status,
      404,
    );
    const first = await (
      await server.app.request("/api/local-threads?limit=1", { headers: headers() })
    ).json();
    assert.equal(first.threads.length, 1);
    await server.localThreads.update("api-alice", first.threads[0].id, { name: "Renamed" });
    const next = await (
      await server.app.request(`/api/local-threads?limit=1&cursor=${first.nextCursor}`, {
        headers: headers(),
      })
    ).json();
    assert.equal(next.threads.length, 1);
    assert.notEqual(next.threads[0].id, first.threads[0].id);
    const entries = await (
      await server.app.request("/api/local-threads/private-card/events?after=2", {
        headers: headers(),
      })
    ).json();
    assert.ok(entries.entries.every((e: { seq: number }) => e.seq > 2));
  } finally {
    await server.agent.stop();
    await server.localThreads.stopAll();
  }
});

test("the actual CopilotKit client runs and reloads local SSE threads with tool cards and no Intelligence calls", async (t) => {
  // The browser client intentionally skips runtime discovery in Node/SSR.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://local-mini.test",
    dataDir: directory,
    agentBackend: "sample",
    threadBackend: "local",
    taskWorkerEnabled: false,
    googleRedirectUri: "http://local-mini.test/api/google/callback",
    allowedOrigins: [],
  });
  const session = await (
    await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  const headers = { Authorization: `Bearer ${session.token}` };
  const paths: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (resource: string | URL | Request, init?: RequestInit) => {
      const request = new Request(resource, init);
      const url = new URL(request.url);
      assert.equal(
        url.origin,
        "http://local-mini.test",
        "local chat must not contact an external thread service",
      );
      paths.push(url.pathname);
      return server.app.fetch(request);
    },
  );
  const client = () =>
    new CopilotKitCore({ runtimeUrl: "http://local-mini.test/api/copilotkit", headers });
  try {
    const core = client();
    await until(async () => Boolean(core.getAgent("default")));
    const agent = core.getAgent("default");
    assert.ok(agent);
    agent.threadId = "sdk-local-thread";
    agent.addMessage({ id: "sdk-user-message", role: "user", content: "Plan my week" });
    await core.runAgent({ agent });
    assert.ok(
      agent.messages.some((m) => m.role === "assistant" && "toolCalls" in m && m.toolCalls?.length),
    );
    assert.ok(agent.messages.some((m) => m.role === "tool"));
    const saved = structuredClone(agent.messages);
    const reopened = client();
    await until(async () => Boolean(reopened.getAgent("default")));
    const replay = reopened.getAgent("default");
    assert.ok(replay);
    replay.threadId = agent.threadId;
    await reopened.connectAgent({ agent: replay });
    assert.deepEqual(replay.messages, saved);
    replay.addMessage({ id: "sdk-follow-up", role: "user", content: "Plan the next verification" });
    await reopened.runAgent({ agent: replay });
    const expected = structuredClone(replay.messages);
    const third = client();
    await until(async () => Boolean(third.getAgent("default")));
    const twice = third.getAgent("default");
    assert.ok(twice);
    twice.threadId = agent.threadId;
    await third.connectAgent({ agent: twice });
    assert.deepEqual(twice.messages, expected);
    assert.equal(twice.messages.filter((m) => m.id === "sdk-user-message").length, 1);
    assert.equal(twice.messages.filter((m) => m.id === "sdk-follow-up").length, 1);
    assert.ok(paths.includes("/api/copilotkit/agent/default/run"));
    assert.ok(paths.includes("/api/copilotkit/agent/default/connect"));
  } finally {
    await server.localThreads.stopAll();
    await server.agent.stop();
  }
});
