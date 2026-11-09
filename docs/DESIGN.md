# Design

Written before the code. Where the implementation later disagreed with this page, the difference is listed in [NOTE.md](NOTE.md), and this page was left as it was.

## Data and the two orders

A **point** is `{key, step, value}`. Its identity is `(run, key, step)` and it never changes once stored. A **batch** is `{batch_id, points[]}` with a client-generated UUID and at most 1000 points. A batch is stored in one transaction or not at all.

There are two orders, and keeping them apart is the core of the design.

- `step` is chosen by the client. Charts are drawn by `step`, so the order in which batches arrive does not change the picture. The server never assigns steps: a server-side counter would give a retried batch new steps.
- `seq` is a per-run counter assigned by the server. A batch that adds at least one new point takes the next `seq`, and every point stores the `seq` that introduced it. The counter lives in the run row and is incremented under that row's lock, which is held until commit. So for one run `seq` order is commit order, and a reader that has seen `seq = n` can never later discover a smaller one. A global sequence or a timestamp does not give this: a transaction with a lower number can commit after a higher one has already been read.

The points table is the event log. There is no separate snapshot format. A page that opens for the first time asks for everything after `seq 0`, and a page that reconnects asks for everything after the last `seq` it applied. It is the same query and the same code path.

## Stream

`GET /runs/{id}/events` is Server-Sent Events, read with `fetch` so the key travels in the `Authorization` header and never in a URL.

```
id: 42
event: points
data: {"from":40,"to":42,"points":[["loss",12,0.31],["acc",12,0.88]]}
```

`from` is the cursor the message continues from, `to` is the cursor after applying it. One message may cover several batches. The client applies it only if `from` equals its own cursor. If `to` is not ahead of the cursor the message is a repeat and is dropped. If `from` is ahead, something was skipped and the client reconnects from its cursor. Applying is idempotent because points are keyed by `(key, step)`.

Every 5 seconds, and on connect, the server also sends `event: run` with the run status, `head` (the latest `seq`) and the stored point count. It is a full state, so a missed one is replaced by the next and needs no replay. It lets the page tell "nothing new" from "I am behind", and compare its own point count with the stored one once the cursors match.

## The same batch sent again

| What arrives | Result |
| --- | --- |
| Same `batch_id`, same content | The stored answer is returned with `replayed: true`. No new `seq`, nothing is sent to streams. |
| Same `batch_id`, different content | `409`. An idempotency key must not be reused for different data. |
| New `batch_id`, point already stored with the same value | Counted in `duplicates`. This covers a client that retries under a new id. |
| New `batch_id`, point already stored with a different value | First write wins. The point is listed in `conflicts` in the response and counted on the run. |

A response lost after commit is the normal case on a bad network, and the first row makes the retry safe.

## Catching up after a disconnect

The client reconnects with `Last-Event-ID: <cursor>`. The server registers the connection for wake-ups first and only then reads the database from that cursor, so a batch committed between the read and the registration still triggers another read. `NOTIFY` is issued inside the ingest transaction and carries only `run:seq`. It is a hint to read. The data always comes from the table, so a lost notification delays delivery until the next 5 second tick and loses nothing.

There is no per-client queue. Each connection reads pages from the database at the pace its socket drains, so a slow client holds one page in memory and simply falls behind. If a cursor is ahead of the server (a restored backup), the server sends `reset` and the client starts from zero.

## Isolation

1. An API key (256 random bits, stored as SHA-256) resolves to exactly one project. Nothing else in a request can choose the project.
2. Every query runs in a transaction that sets `app.project_id`. Row-level security is forced on every table and the application connects as a role that does not own them. A query that forgets its `WHERE` returns nothing from other projects.
3. Another project's run and a run that does not exist give the same `404` with the same body, from the same single query. The access check comes before body validation, so a `422` cannot confirm that an id exists.
4. Ids are UUIDv4. Batch ids are unique per run, so they cannot be probed across projects.
5. Live connections are registered under the key that opened them. Revoking or rotating a key closes them at once, and the 5 second tick re-checks the key in case that signal is lost. There is no auth cache to go stale.
6. Every response is `Cache-Control: no-store`. Logs carry key ids, never key material.

## Left out on purpose

Users and roles, read-only keys, rate limits per project, server-side downsampling for very long runs, retention, more than one API instance (the design allows it, it is not tested).
