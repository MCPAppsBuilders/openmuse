import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "./workspace";

type Thread = { id: string; name: string | null; archived: boolean };
type Page = { threads: Thread[]; nextCursor: string | null };
export function useLocalThreads(enabled: boolean) {
  const { api } = useWorkspace();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(enabled);
  const [isFetchingMoreThreads, setFetching] = useState(false);
  const [isMutating, setMutating] = useState(false);
  const [error, setError] = useState<Error>();
  const [fetchMoreError, setMoreError] = useState<Error>();
  const generation = useRef(0);
  const load = useCallback(
    async (after?: string) => {
      if (!enabled) return;
      const current = ++generation.current;
      if (after) {
        setFetching(true);
        setMoreError(undefined);
      } else {
        setLoading(true);
        setError(undefined);
      }
      try {
        const page = await api.request<Page>(
          `/api/local-threads?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ""}`,
        );
        if (current !== generation.current) return;
        setThreads((previous) =>
          after
            ? [...previous, ...page.threads.filter((t) => !previous.some((p) => p.id === t.id))]
            : page.threads,
        );
        setCursor(page.nextCursor);
      } catch (e) {
        if (current === generation.current)
          (after ? setMoreError : setError)(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (current === generation.current) {
          setLoading(false);
          setFetching(false);
        }
      }
    },
    [api, enabled],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  async function update(id: string, patch: { name?: string; archived?: boolean }) {
    setMutating(true);
    try {
      const thread = await api.request<Thread>(
        `/api/local-threads/${encodeURIComponent(id)}`,
        patch,
        "PATCH",
      );
      setThreads((previous) => previous.map((t) => (t.id === id ? thread : t)));
    } finally {
      setMutating(false);
    }
  }
  return {
    threads,
    isLoading,
    isFetchingMoreThreads,
    isMutating,
    error,
    fetchMoreError,
    hasMoreThreads: cursor !== null,
    refetchThreads: () => {
      void load();
    },
    fetchMoreThreads: () => {
      if (cursor && !isFetchingMoreThreads) void load(cursor);
    },
    renameThread: (id: string, name: string) => update(id, { name }),
    archiveThread: (id: string) => update(id, { archived: true }),
    unarchiveThread: (id: string) => update(id, { archived: false }),
  };
}
