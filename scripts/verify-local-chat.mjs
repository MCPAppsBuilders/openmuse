// Local sample-workspace verification. Never writes session tokens to evidence.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.MINI_API_URL ?? "http://127.0.0.1:18160";
const url = new URL(base);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Use a local sample workspace",
);
const directory = new URL("../artifacts/local-mini-verification/", import.meta.url);
const evidencePath = new URL("http-smoke.json", directory);
const sessionResponse = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(sessionResponse.status, 200);
const session = await sessionResponse.json();
assert.equal(session.mode, "sample");
const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, `HTTP ${response.status} at ${path}`);
  return response;
}
function events(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
const info = await (await request("/api/copilotkit/info")).json();
assert.equal(info.mode, "sse");
assert.equal(info.intelligence, undefined);
const main = await (await request("/api/main-thread")).json();
const replayOnly = process.argv.includes("--replay-only");
let evidence;
if (replayOnly) {
  evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(main.threadId, evidence.mainThreadId);
} else {
  const threadId = `mini-${randomUUID()}`;
  const response = await request("/api/copilotkit/agent/default/run", {
    threadId,
    runId: randomUUID(),
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [
      { id: randomUUID(), role: "user", content: "Plan a local persistence verification" },
    ],
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const runEvents = events(await response.text());
  assert.ok(runEvents.some((e) => e.type === "RUN_FINISHED"));
  assert.ok(!runEvents.some((e) => e.type === "RUN_ERROR"));
  const results = runEvents.filter((e) => e.type === "TOOL_CALL_RESULT");
  assert.ok(results.length > 0);
  evidence = {
    base,
    backend: "local",
    mode: "sample",
    mainThreadId: main.threadId,
    threadId,
    toolResults: results.map((e) => ({ toolCallId: e.toolCallId, content: e.content })),
    runEventCount: runEvents.length,
  };
}
const replay = events(
  await (
    await request("/api/copilotkit/agent/default/connect", {
      threadId: evidence.threadId,
      runId: randomUUID(),
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    })
  ).text(),
);
assert.deepEqual(
  replay
    .filter((e) => e.type === "TOOL_CALL_RESULT")
    .map((e) => ({ toolCallId: e.toolCallId, content: e.content })),
  evidence.toolResults,
);
const journal = await (
  await request(`/api/local-threads/${evidence.threadId}/events?after=0`)
).json();
assert.ok(journal.cursor > 0);
evidence = {
  ...evidence,
  replayEventCount: replay.length,
  journalCursor: journal.cursor,
  ...(replayOnly ? { verifiedAfterServerRestart: true } : {}),
  verifiedAt: new Date().toISOString(),
};
await mkdir(directory, { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  JSON.stringify({
    backend: evidence.backend,
    runEventCount: evidence.runEventCount,
    replayEventCount: evidence.replayEventCount,
    verifiedAfterServerRestart: evidence.verifiedAfterServerRestart ?? false,
    evidence: fileURLToPath(evidencePath),
  }),
);
