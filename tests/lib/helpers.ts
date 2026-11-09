import pg from 'pg';
import {
  Client,
  SseParser,
  decodeValue,
  makeBatch,
  uuidv4,
  type BatchRequest,
  type Point,
  type SseEvent,
} from '@simmer/sdk';
import { API_URL, OWNER_DATABASE_URL } from './env.ts';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Small seeded generator so every failing run can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

let ownerPool: pg.Pool | undefined;

/** The owner connection bypasses row-level security. It is the tests' view of the truth. */
export function owner(): pg.Pool {
  ownerPool ??= new pg.Pool({ connectionString: OWNER_DATABASE_URL, max: 4 });
  return ownerPool;
}

export async function closeOwner(): Promise<void> {
  await ownerPool?.end();
  ownerPool = undefined;
}

export interface Tenant {
  projectId: string;
  keyId: string;
  secret: string;
  client: Client;
}

export async function newTenant(name = 'tenant', baseUrl = API_URL): Promise<Tenant> {
  const made = await new Client({ baseUrl }).createProject(`${name}-${uuidv4().slice(0, 8)}`);
  return {
    projectId: made.project.id,
    keyId: made.api_key.id,
    secret: made.api_key.secret,
    client: new Client({ baseUrl, apiKey: made.api_key.secret }),
  };
}

export function batchOf(points: Point[], batchId?: string): BatchRequest {
  return makeBatch(points, batchId);
}

export function series(key: string, from: number, to: number, f = (s: number) => s * 0.5): Point[] {
  const out: Point[] = [];
  for (let step = from; step < to; step++) out.push({ key, step, value: f(step) });
  return out;
}

export type Row = [key: string, step: number, value: number];

/** Stored points of a run, straight from the table, ordered by key then step. */
export async function storedPoints(runId: string): Promise<Row[]> {
  const found = await owner().query(
    'select key, step, value from points where run_id = $1 order by key collate "C", step',
    [runId],
  );
  return found.rows.map((r) => [r.key, Number(r.step), r.value as number]);
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}

/** Rows as text, so NaN compares equal to NaN and a diff is readable. */
export function rowsText(rows: Row[]): string[] {
  return rows.map(([key, step, value]) => `${key} ${step} ${Object.is(value, -0) ? 0 : value}`);
}

/**
 * Checks that the stored data is internally consistent. It is the kind of
 * audit that could run on a schedule in production. Returns the violations.
 */
export async function invariantViolations(runIds?: string[]): Promise<string[]> {
  const db = owner();
  const scope = runIds ? 'where r.id = any($1)' : '';
  const args = runIds ? [runIds] : [];
  const problems: string[] = [];
  const counters = await db.query(
    `select r.id, r.last_seq, r.point_count,
            (select count(*) from points p where p.run_id = r.id) as real_count,
            (select coalesce(max(seq), 0) from points p where p.run_id = r.id) as real_head,
            (select count(distinct seq) from points p where p.run_id = r.id) as distinct_seqs
     from runs r ${scope}`,
    args,
  );
  for (const r of counters.rows) {
    if (r.point_count !== r.real_count) {
      problems.push(`run ${r.id}: point_count ${r.point_count}, table has ${r.real_count}`);
    }
    if (r.last_seq !== r.real_head) {
      problems.push(`run ${r.id}: last_seq ${r.last_seq}, highest stored seq ${r.real_head}`);
    }
    if (r.distinct_seqs !== r.real_head) {
      problems.push(`run ${r.id}: ${r.distinct_seqs} distinct seqs below head ${r.real_head}, there is a hole`);
    }
  }
  const batches = await db.query(
    `select b.run_id, b.batch_id, (b.result->>'seq')::bigint as seq, (b.result->>'accepted')::int as accepted,
            (select count(*) from points p where p.run_id = b.run_id and p.seq = (b.result->>'seq')::bigint) as stored
     from batches b join runs r on r.id = b.run_id ${scope}`,
    args,
  );
  for (const b of batches.rows) {
    const stored = b.seq === null ? 0 : Number(b.stored);
    if (stored !== b.accepted) {
      problems.push(`batch ${b.batch_id}: answered accepted=${b.accepted}, ${stored} points stored under seq ${b.seq}`);
    }
  }
  const strays = await db.query(
    `select count(*) as n from points p join runs r on r.id = p.run_id
     where p.project_id <> r.project_id ${runIds ? 'and r.id = any($1)' : ''}`,
    args,
  );
  if (Number(strays.rows[0].n) > 0) problems.push(`${strays.rows[0].n} points filed under the wrong project`);
  return problems;
}

export interface RawStream {
  status: number;
  headers: Headers;
  events: SseEvent[];
  /** Every `points` message, parsed. */
  messages: { from: number; to: number; points: [string, number, unknown][] }[];
  ended: boolean;
  waitFor(predicate: (s: RawStream) => boolean, timeoutMs?: number, what?: string): Promise<void>;
  rows(): Row[];
  close(): void;
}

/**
 * A plain SSE reader with no reconnect and no cursor logic of its own, so the
 * tests see exactly what the server put on the wire for one connection.
 */
export async function openStream(
  secret: string,
  runId: string,
  options: { after?: number; baseUrl?: string; query?: string } = {},
): Promise<RawStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (options.after !== undefined) headers['last-event-id'] = String(options.after);
  const response = await fetch(
    `${options.baseUrl ?? API_URL}/runs/${runId}/events${options.query ?? ''}`,
    { headers, signal: controller.signal },
  );
  const stream: RawStream = {
    status: response.status,
    headers: response.headers,
    events: [],
    messages: [],
    ended: false,
    async waitFor(predicate, timeoutMs = 10_000, what = 'condition') {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(stream)) {
        if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
        await sleep(10);
      }
    },
    rows() {
      const rows: Row[] = [];
      for (const m of stream.messages) {
        for (const [key, step, value] of m.points) rows.push([key, step, decodeValue(value)!]);
      }
      return rows;
    },
    close() {
      controller.abort();
    },
  };
  if (response.status !== 200 || !response.body) {
    stream.ended = true;
    return stream;
  }
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          stream.events.push(event);
          if (event.event === 'points') stream.messages.push(JSON.parse(event.data));
        }
      }
    } catch {
      // Aborted or cut. Either way the stream is over.
    }
    stream.ended = true;
  })();
  return stream;
}

/** Fails unless the messages of one connection form an unbroken chain from `start`. */
export function assertChain(stream: RawStream, start: number): number {
  let cursor = start;
  for (const m of stream.messages) {
    if (m.from !== cursor) throw new Error(`Chain broken: message continues from ${m.from}, reader was at ${cursor}`);
    if (m.to <= m.from) throw new Error(`Message does not advance: ${m.from} to ${m.to}`);
    cursor = m.to;
  }
  return cursor;
}
