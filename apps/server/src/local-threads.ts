import { type BaseEvent, compactEvents, EventType, type RunStartedEvent } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { Observable, of, ReplaySubject } from "rxjs";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const kind = "local-chat-threads";
const journal = (id: string) => `local-chat-events:${id}`;
export interface LocalThread {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  runId?: string;
}
interface Entry {
  id: string;
  seq: number;
  runId: string;
  event: BaseEvent;
}
type Active = {
  request: AgentRunnerRunRequest;
  events: ReplaySubject<Entry>;
  stopped: boolean;
};
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
export function threadIdentifier(id: string) {
  if (typeof id !== "string" || !identifier.test(id))
    throw new AppError("Invalid thread identifier", 422);
  return id;
}

/** Single application-server coordinator. SQL is durable; active agents live in this process. */
export class LocalThreads {
  private runners = new Map<string, LocalThreadRunner>();
  constructor(readonly db: Store) {}
  runner(owner: string) {
    let runner = this.runners.get(owner);
    if (!runner) {
      runner = new LocalThreadRunner(this, owner);
      this.runners.set(owner, runner);
    }
    return runner;
  }
  async ensure(owner: string, id: string): Promise<LocalThread> {
    threadIdentifier(id);
    const now = new Date().toISOString();
    await this.db.insertIfAbsent(owner, kind, {
      id,
      name: null,
      agentId: "default",
      archived: false,
      createdAt: now,
      updatedAt: now,
      running: false,
    });
    return this.get(owner, id);
  }
  async get(owner: string, id: string) {
    const thread = await this.db.get<LocalThread>(owner, kind, threadIdentifier(id));
    if (!thread) throw new AppError("Conversation not found", 404);
    return thread;
  }
  async list(owner: string, limit = 20, cursor?: string) {
    const items = (await this.db.list<LocalThread>(owner, kind)).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    // Creation ordering gives stable pagination even as active threads are updated.
    const start = cursor ? items.findIndex((t) => t.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw new AppError("Invalid conversation cursor", 422);
    const threads = items.slice(start, start + limit);
    return {
      threads,
      nextCursor: start + limit < items.length ? (threads.at(-1)?.id ?? null) : null,
    };
  }
  async update(owner: string, id: string, patch: { name?: string; archived?: boolean }) {
    await this.get(owner, id);
    return this.db.compareAndSwap<LocalThread>(
      owner,
      kind,
      id,
      {},
      {
        ...patch,
        updatedAt: new Date().toISOString(),
      },
    );
  }
  async entries(owner: string, id: string) {
    return (await this.db.list<Entry>(owner, journal(threadIdentifier(id)))).sort(
      (a, b) => a.seq - b.seq,
    );
  }
  async append(owner: string, id: string, runId: string, seq: number, event: BaseEvent) {
    const entry = { id: String(seq).padStart(16, "0"), seq, runId, event: structuredClone(event) };
    // A collision must never overwrite an accepted journal entry.
    if (!(await this.db.insertIfAbsent(owner, journal(id), entry)))
      throw new Error("Conversation journal conflict");
    return entry;
  }
  /** Call once at server startup, before accepting traffic. No tool is re-executed. */
  async recoverInterrupted() {
    for (const { owner, value: thread } of await this.db.scan<LocalThread>(kind)) {
      if (!thread.running) continue;
      const entries = await this.entries(owner, thread.id);
      const current = entries.filter((e) => e.runId === thread.runId).map((e) => e.event);
      const closing = finalizeRunEvents(current, {
        interruptionMessage:
          "Server restarted during this reply. Review the saved result before continuing.",
      });
      let seq = entries.at(-1)?.seq ?? 0;
      if (!thread.runId) throw new Error("Interrupted conversation has no run identifier");
      for (const event of closing) await this.append(owner, thread.id, thread.runId, ++seq, event);
      await this.db.compareAndSwap(
        owner,
        kind,
        thread.id,
        { running: true, runId: thread.runId },
        { running: false },
      );
    }
  }
  async stopAll() {
    await Promise.all([...this.runners.values()].map((r) => r.stopAll()));
  }
}

export class LocalThreadRunner extends AgentRunner {
  private active = new Map<string, Active>();
  constructor(
    private store: LocalThreads,
    private owner: string,
  ) {
    super();
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const id = threadIdentifier(request.threadId);
    if (this.active.has(id))
      return of({
        type: EventType.RUN_ERROR,
        message: "Thread already running",
        code: "THREAD_LOCKED",
      });
    const active: Active = { request, events: new ReplaySubject<Entry>(), stopped: false };
    this.active.set(id, active);
    // Execution has its own lifetime. Unsubscribing the HTTP client only detaches its reader.
    void this.execute(id, active);
    return new Observable((observer) =>
      active.events.subscribe({
        next: (entry) => observer.next(entry.event),
        error: (e) => observer.error(e),
        complete: () => observer.complete(),
      }),
    );
  }
  private async execute(id: string, active: Active) {
    let claimed = false;
    try {
      const thread = await this.store.ensure(this.owner, id);
      if (thread.archived) throw new Error("Restore this conversation before sending a message");
      const runId = threadIdentifier(active.request.input.runId);
      const entries = await this.store.entries(this.owner, id);
      if (entries.some((e) => e.runId === runId))
        throw new Error("This run has already been accepted");
      claimed = Boolean(
        await this.store.db.compareAndSwap(
          this.owner,
          kind,
          id,
          { running: false },
          {
            running: true,
            runId,
            updatedAt: new Date().toISOString(),
          },
        ),
      );
      if (!claimed) throw new Error("Thread already running");
      let seq = entries.at(-1)?.seq ?? 0;
      const current: BaseEvent[] = [];
      let writes = Promise.resolve();
      let storageError: unknown;
      const append = (event: BaseEvent) => {
        const copy = structuredClone(event);
        writes = writes.then(async () => {
          const entry = await this.store.append(this.owner, id, runId, ++seq, copy);
          current.push(copy);
          active.events.next(entry);
        });
        return writes;
      };
      const seen = new Set<string>();
      for (const { event } of entries) {
        if ("messageId" in event) seen.add(String(event.messageId));
        if (event.type === EventType.RUN_STARTED)
          for (const message of (event as RunStartedEvent).input?.messages ?? [])
            seen.add(message.id);
      }
      let failure: unknown;
      try {
        if (active.stopped) throw new Error("Reply stopped before starting");
        await active.request.agent.runAgent(active.request.input, {
          onEvent: async ({ event }) => {
            if (storageError) return;
            const copy = structuredClone(event);
            if (copy.type === EventType.RUN_STARTED)
              copy.input = {
                ...active.request.input,
                messages: active.request.input.messages.filter((m) => !seen.has(m.id)),
              };
            try {
              await append(copy);
            } catch (error) {
              storageError = error;
              active.request.agent.abortRun();
              void active.request.agent.detachActiveRun().catch(() => {});
            }
          },
        });
      } catch (error) {
        failure = error;
      }
      await writes;
      if (storageError) throw storageError;
      const closing = finalizeRunEvents(current, {
        stopRequested: active.stopped,
        ...(failure && !active.stopped
          ? { interruptionMessage: failure instanceof Error ? failure.message : "Reply failed" }
          : {}),
      });
      for (const event of closing) await append(event);
      await this.store.db.compareAndSwap(
        this.owner,
        kind,
        id,
        { runId },
        { running: false, updatedAt: new Date().toISOString() },
      );
      active.events.complete();
    } catch (error) {
      // A storage failure leaves the SQL run marked active so startup recovery can close its journal.
      active.events.next({
        id: "refused",
        seq: -1,
        runId: active.request.input.runId,
        event: {
          type: EventType.RUN_ERROR,
          message: claimed
            ? "Could not save this reply. Restart the server before continuing."
            : error instanceof Error
              ? error.message
              : "Reply could not start",
        },
      });
      active.events.complete();
    } finally {
      this.active.delete(id);
    }
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const id = threadIdentifier(request.threadId);
    const active = this.active.get(id);
    return new Observable((observer) => {
      let cancelled = false;
      let subscription: { unsubscribe(): void } | undefined;
      void (async () => {
        await this.store.get(this.owner, id);
        const entries = await this.store.entries(this.owner, id);
        const last = entries.at(-1)?.seq ?? 0;
        if (cancelled) return;
        // Full AG-UI replay preserves cards and state, including a partial active reply.
        for (const event of compactEvents(entries.map((e) => e.event))) observer.next(event);
        if (active)
          subscription = active.events.subscribe({
            next: (entry) => {
              if (entry.seq === -1 || entry.seq > last) observer.next(entry.event);
            },
            complete: () => observer.complete(),
            error: (e) => observer.error(e),
          });
        else observer.complete();
      })().catch((e) => observer.error(e));
      return () => {
        cancelled = true;
        subscription?.unsubscribe();
      };
    });
  }
  async isRunning({ threadId }: { threadId: string }) {
    return this.active.has(threadId);
  }
  async stop({ threadId, runId }: AgentRunnerStopRequest) {
    const active = this.active.get(threadId);
    if (!active || (runId && runId !== active.request.input.runId)) return false;
    active.stopped = true;
    active.request.agent.abortRun();
    await active.request.agent.detachActiveRun();
    return true;
  }
  async stopAll() {
    for (const [threadId] of this.active) await this.stop({ threadId });
    await Promise.all(
      [...this.active.values()].map(
        (a) =>
          new Promise<void>((resolve) => {
            a.events.subscribe({ complete: resolve, error: resolve });
          }),
      ),
    );
  }
}
