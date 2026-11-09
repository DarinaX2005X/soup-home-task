import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import pg from 'pg';
import {
  encodeValue,
  type ByeMessage,
  type PointsMessage,
  type RunStateMessage,
  type WirePoint,
} from '@simmer/sdk';
import type { Auth } from './auth.ts';
import type { Config } from './config.ts';
import { withProject, type Db } from './db.ts';

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * One open SSE response. It owns a cursor and reads the points table from that
 * cursor whenever it is woken, at the pace its socket drains. There is no
 * per-connection queue that could overflow: the only thing buffered for a slow
 * reader is the page currently being written.
 */
export class Connection {
  private closed = false;
  private dirty = true;
  private wakeSleep: (() => void) | undefined;
  private lastStateAt = 0;
  private readonly hub: Hub;
  private readonly res: ServerResponse;
  readonly auth: Auth;
  readonly runId: string;
  private cursor: number;

  constructor(hub: Hub, res: ServerResponse, auth: Auth, runId: string, cursor: number) {
    this.hub = hub;
    this.res = res;
    this.auth = auth;
    this.runId = runId;
    this.cursor = cursor;
    res.on('close', () => this.dispose());
  }

  get bufferedBytes(): number {
    return this.res.writableLength;
  }

  /** New data may exist for this run. Safe to call at any time, any number of times. */
  wake(stateChanged = false): void {
    if (stateChanged) this.lastStateAt = 0;
    this.dirty = true;
    this.wakeSleep?.();
  }

  async close(reason: ByeMessage['reason']): Promise<void> {
    if (this.closed) return;
    this.res.write(`event: bye\ndata: ${JSON.stringify({ reason } satisfies ByeMessage)}\n\n`);
    this.dispose();
    this.res.end();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.remove(this);
    this.wakeSleep?.();
  }

  async run(): Promise<void> {
    const { heartbeatMs } = this.hub.config;
    try {
      while (!this.closed) {
        if (Date.now() - this.lastStateAt >= heartbeatMs) {
          if (!(await this.sendRunState())) return;
        }
        // Clear the flag before reading. A wake-up that lands during the read
        // sets it again and forces one more read, so a batch committed while
        // we were reading is never left waiting for the next heartbeat.
        this.dirty = false;
        const sent = await this.sendNextPage();
        if (this.closed) return;
        if (sent > 0 || this.dirty) continue;
        const remaining = heartbeatMs - (Date.now() - this.lastStateAt);
        await this.sleep(Math.max(remaining, 0));
      }
    } catch (error) {
      this.hub.log.warn({ err: error, run_id: this.runId }, 'stream failed');
      this.dispose();
      this.res.destroy();
    }
  }

  /** Sends the run state and re-checks the key. Returns false if the stream ended. */
  private async sendRunState(): Promise<boolean> {
    const row = await withProject(this.hub.db, this.auth.projectId, async (tx) => {
      const found = await tx.query(
        `select r.status, r.last_seq, r.point_count, r.conflict_count, r.finished_at,
                exists (select 1 from api_keys k where k.id = $2 and k.revoked_at is null) as key_ok
         from runs r where r.id = $1`,
        [this.runId, this.auth.keyId],
      );
      return found.rows[0];
    });
    this.lastStateAt = Date.now();
    if (!row) {
      await this.close('run_gone');
      return false;
    }
    if (!row.key_ok) {
      await this.close('key_revoked');
      return false;
    }
    const head = Number(row.last_seq);
    if (this.cursor > head) {
      // The reader is ahead of the database, which means the database went
      // back in time (a restore). Its view cannot be patched, only rebuilt.
      this.cursor = 0;
      if (!(await this.write('event: reset\ndata: {}\n\n'))) return false;
    }
    const state: RunStateMessage = {
      status: row.status,
      head,
      points: Number(row.point_count),
      conflicts: Number(row.conflict_count),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    };
    return this.write(`event: run\ndata: ${JSON.stringify(state)}\n\n`);
  }

  /** Reads and writes one page after the cursor. Returns the number of points sent. */
  private async sendNextPage(): Promise<number> {
    const limit = this.hub.config.streamPageRows;
    const { rows } = await this.hub.db.query(
      'select key, step, value, seq from stream_page($1, $2, $3, $4)',
      [this.auth.projectId, this.runId, this.cursor, limit + 1],
    );
    if (rows.length === 0) return 0;
    let take = rows.length;
    if (rows.length > limit) {
      // The page was cut by the limit, so the last seq in it may be
      // incomplete. Drop that seq and send it whole next time. A batch holds
      // at most 1000 points and the limit is larger, so this always advances.
      const cut = rows[rows.length - 1].seq;
      while (take > 0 && rows[take - 1].seq === cut) take--;
    }
    const points: WirePoint[] = new Array(take);
    for (let i = 0; i < take; i++) {
      const r = rows[i];
      points[i] = [r.key, Number(r.step), encodeValue(r.value)];
    }
    const to = Number(rows[take - 1].seq);
    const message: PointsMessage = { from: this.cursor, to, points };
    const ok = await this.write(`id: ${to}\nevent: points\ndata: ${JSON.stringify(message)}\n\n`);
    if (ok) this.cursor = to;
    return ok ? take : 0;
  }

  /** Writes and waits for the socket to drain. A reader that never drains is cut off. */
  private write(chunk: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.res.write(chunk)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.res.off('drain', onDrain);
        this.res.off('close', onClose);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => {
        this.hub.log.info({ run_id: this.runId, key_id: this.auth.keyId }, 'stream stalled, closing');
        this.dispose();
        this.res.destroy();
        finish(false);
      }, this.hub.config.stallMs);
      this.res.once('drain', onDrain);
      this.res.once('close', onClose);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wakeSleep = undefined;
        resolve();
      }
      this.wakeSleep = done;
    });
  }
}

/**
 * Tracks open streams and wakes them when a run has new data or a key was
 * revoked. A wake-up only says "look again": the data is always read from the
 * table. If a wake-up is lost, or the listener connection drops, the heartbeat
 * finds the same data a few seconds later.
 *
 * Streams on this instance are woken directly, right after the commit. Other
 * instances hear about it through Postgres NOTIFY, sent outside the write
 * transaction and at most once every 25 ms for all runs together. NOTIFY
 * inside the write transaction was measured to serialize every commit in the
 * database behind one lock.
 */
export class Hub {
  private readonly byRun = new Map<string, Set<Connection>>();
  private readonly byKey = new Map<string, Set<Connection>>();
  private readonly byProject = new Map<string, number>();
  private listener: pg.Client | undefined;
  private stopping = false;
  /** Tells our own notifications apart from those of other instances. */
  private readonly instance = randomUUID().slice(0, 8);
  private readonly outbox = new Set<string>();
  private outboxTimer: ReturnType<typeof setTimeout> | undefined;
  readonly db: Db;
  readonly config: Config;
  readonly log: Logger;

  constructor(db: Db, config: Config, log: Logger) {
    this.db = db;
    this.config = config;
    this.log = log;
  }

  get size(): number {
    let total = 0;
    for (const set of this.byRun.values()) total += set.size;
    return total;
  }

  get bufferedBytes(): number {
    let total = 0;
    for (const set of this.byRun.values()) for (const c of set) total += c.bufferedBytes;
    return total;
  }

  streamsFor(projectId: string): number {
    return this.byProject.get(projectId) ?? 0;
  }

  /**
   * Registers the connection for wake-ups and only then starts its first read.
   * A batch that commits in between triggers a wake-up that the first read
   * either already covers or is followed by.
   */
  attach(res: ServerResponse, auth: Auth, runId: string, cursor: number): Connection {
    const connection = new Connection(this, res, auth, runId, cursor);
    add(this.byRun, runId, connection);
    add(this.byKey, auth.keyId, connection);
    this.byProject.set(auth.projectId, this.streamsFor(auth.projectId) + 1);
    void connection.run();
    return connection;
  }

  remove(connection: Connection): void {
    drop(this.byRun, connection.runId, connection);
    drop(this.byKey, connection.auth.keyId, connection);
    const left = this.streamsFor(connection.auth.projectId) - 1;
    if (left > 0) this.byProject.set(connection.auth.projectId, left);
    else this.byProject.delete(connection.auth.projectId);
  }

  /** Call after a commit that changed a run: new points, or its state. */
  published(runId: string, stateChanged = false): void {
    for (const c of this.byRun.get(runId) ?? []) c.wake(stateChanged);
    this.outbox.add(stateChanged ? `${runId}:state` : runId);
    this.outboxTimer ??= setTimeout(() => void this.flushOutbox(), 25);
  }

  private async flushOutbox(): Promise<void> {
    this.outboxTimer = undefined;
    const payloads = [...this.outbox].map((entry) => `${this.instance}:${entry}`);
    this.outbox.clear();
    try {
      await this.db.query("select pg_notify('run_seq', p) from unnest($1::text[]) as p", [payloads]);
    } catch (error) {
      // Other instances will find the data at their next heartbeat.
      this.log.warn({ err: error }, 'could not notify other instances');
    }
  }

  async start(): Promise<void> {
    await this.listen();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const all = [...this.byRun.values()].flatMap((set) => [...set]);
    await Promise.all(all.map((c) => c.close('shutdown')));
    clearTimeout(this.outboxTimer);
    await this.listener?.end().catch(() => {});
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.databaseUrl });
    const lost = (error?: Error) => {
      if (this.listener !== client || this.stopping) return;
      this.listener = undefined;
      this.log.warn({ err: error }, 'notification listener lost, reconnecting');
      setTimeout(() => void this.listen().catch(lost), 500);
    };
    client.on('error', lost);
    client.on('end', () => lost());
    client.on('notification', (message) => {
      if (message.channel === 'run_seq') {
        const [from, runId, flag] = (message.payload ?? '').split(':');
        if (from === this.instance) return;
        for (const c of this.byRun.get(runId ?? '') ?? []) c.wake(flag === 'state');
      } else if (message.channel === 'key_revoked') {
        for (const c of [...(this.byKey.get(message.payload ?? '') ?? [])]) {
          void c.close('key_revoked');
        }
      }
    });
    this.listener = client;
    await client.connect();
    await client.query('listen run_seq');
    await client.query('listen key_revoked');
    // Anything notified while we were not listening is found by this read.
    for (const set of this.byRun.values()) for (const c of set) c.wake();
  }
}

function add(map: Map<string, Set<Connection>>, key: string, value: Connection): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function drop(map: Map<string, Set<Connection>>, key: string, value: Connection): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}
