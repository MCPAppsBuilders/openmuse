# OpenMuse local prototype

- Preserve pre-existing shopping, model, and interface changes. Do not reset this checkout.
- `THREAD_BACKEND=local` is the independent, single-server conversation backend. Keep the Intelligence backend selectable explicitly.
- Persist AG-UI events before publishing them; preserve tool results, activity and state events when replaying.
- Scope all thread operations, including run/connect/stop, by the authenticated server-side owner. Never accept an owner from the request body.
- A disconnected client must not abort its server run. A server restart marks unfinished chat runs interrupted; never silently repeat their tools.
- Verify persistence across reopening the database, active-run reconnect, concurrency refusal, stop, ownership, and rendered web behavior for changes to the local backend.
- Keep credentials and private conversation data out of source control and verification artifacts.
