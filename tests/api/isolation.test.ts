import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';
import { uuidv4, type Run } from '@simmer/sdk';
import { API_LOG_FILE, API_URL, APP_DATABASE_URL, WEB_URL } from '../lib/env.ts';
import {
  batchOf,
  closeOwner,
  newTenant,
  openStream,
  owner,
  series,
  sleep,
  storedPoints,
  type Tenant,
} from '../lib/helpers.ts';

// Project A is the attacker in every test below. It holds a valid key of its
// own and knows the exact ids of everything in project B.
let a: Tenant;
let b: Tenant;
let runA: Run;
let runB: Run;
let batchB: string;

async function call(secret: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(API_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function stateOfB() {
  const run = await owner().query(
    'select status, last_seq, point_count, conflict_count, name from runs where id = $1',
    [runB.id],
  );
  const keys = await owner().query(
    'select id, revoked_at from api_keys where project_id = $1 order by id',
    [b.projectId],
  );
  const batches = await owner().query('select count(*) from batches where run_id = $1', [runB.id]);
  return JSON.stringify({ run: run.rows, keys: keys.rows, batches: batches.rows, points: await storedPoints(runB.id) });
}

beforeAll(async () => {
  a = await newTenant('iso-a');
  b = await newTenant('iso-b');
  runA = await a.client.createRun('a-run');
  runB = await b.client.createRun('b-secret-run-name');
  batchB = uuidv4();
  await a.client.sendMetrics(runA.id, batchOf(series('loss', 0, 10)));
  await b.client.sendMetrics(runB.id, batchOf(series('b-secret-metric', 0, 10), batchB));
});

afterAll(closeOwner);

describe('project A cannot read project B', () => {
  test('every read of a run in B answers exactly like a run that does not exist', async () => {
    const ghost = uuidv4();
    for (const suffix of ['', '/metrics', '/metrics?after=0', '/events']) {
      const foreign = await call(a.secret, 'GET', `/runs/${runB.id}${suffix}`);
      const missing = await call(a.secret, 'GET', `/runs/${ghost}${suffix}`);
      expect(foreign.status, suffix).toBe(404);
      expect(foreign.text, suffix).toBe(missing.text);
      expect(foreign.headers.get('content-type'), suffix).toBe(missing.headers.get('content-type'));
      expect(foreign.headers.get('content-length'), suffix).toBe(missing.headers.get('content-length'));
    }
  });

  test('lists contain only the caller\'s own rows', async () => {
    const runs = (await a.client.listRuns()).runs;
    expect(runs.map((r) => r.id)).toEqual([runA.id]);
    const keys = (await a.client.listKeys()).keys;
    expect(keys.map((k) => k.id)).toEqual([a.keyId]);
    expect((await a.client.getProject()).id).toBe(a.projectId);
  });

  test('a request cannot name a project: parameters and headers that try are ignored', async () => {
    const tries = [
      `/runs?project_id=${b.projectId}`,
      `/runs?project=${b.projectId}`,
      `/project?id=${b.projectId}`,
    ];
    for (const path of tries) {
      const response = await call(a.secret, 'GET', path, undefined, {
        'x-project-id': b.projectId,
        'x-forwarded-user': b.keyId,
      });
      expect(response.text).not.toContain(runB.id);
      expect(response.text).not.toContain('b-secret');
      expect(response.text).not.toContain(b.projectId);
    }
    const created = await call(a.secret, 'POST', '/runs', { name: 'x', project_id: b.projectId });
    expect(created.status).toBe(201);
    const owned = await owner().query('select project_id from runs where id = $1', [JSON.parse(created.text).id]);
    expect(owned.rows[0].project_id).toBe(a.projectId);
  });
});

describe('project A cannot write to project B', () => {
  test('no write aimed at B changes anything in B', async () => {
    const before = await stateOfB();
    const attempts = [
      await call(a.secret, 'POST', `/runs/${runB.id}/metrics`, batchOf(series('loss', 100, 110))),
      await call(a.secret, 'POST', `/runs/${runB.id}/metrics`, batchOf(series('b-secret-metric', 0, 10), batchB)),
      await call(a.secret, 'POST', `/runs/${runB.id}/finish`, { status: 'failed' }),
      await call(a.secret, 'POST', `/keys/${b.keyId}/rotate`),
      await call(a.secret, 'DELETE', `/keys/${b.keyId}`),
    ];
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(await stateOfB()).toBe(before);
    // B's key still works after A tried to rotate and revoke it.
    expect((await b.client.getRun(runB.id)).id).toBe(runB.id);
  });

  test('an invalid body sent to a run in B is still a 404, so a 422 cannot confirm the id', async () => {
    const ghost = uuidv4();
    const bodies: unknown[] = [{}, { batch_id: 'x', points: [] }, { batch_id: uuidv4(), points: [{ key: 'a b', step: -1 }] }];
    for (const body of bodies) {
      const foreign = await call(a.secret, 'POST', `/runs/${runB.id}/metrics`, body);
      const missing = await call(a.secret, 'POST', `/runs/${ghost}/metrics`, body);
      const own = await call(a.secret, 'POST', `/runs/${runA.id}/metrics`, body);
      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(missing.text);
      expect(own.status).toBe(422);
    }
    const foreignFinish = await call(a.secret, 'POST', `/runs/${runB.id}/finish`, { status: 'nonsense' });
    expect(foreignFinish.status).toBe(404);
    // Unparseable JSON is rejected before any id is looked at: same answer for all three.
    const statuses = [];
    for (const id of [runB.id, ghost, runA.id]) {
      statuses.push((await call(a.secret, 'POST', `/runs/${id}/metrics`, '{"oops')).status);
    }
    expect(statuses).toEqual([400, 400, 400]);
  });

  test('a batch_id that exists in B tells A nothing: it is unique per run, not globally', async () => {
    const result = await a.client.sendMetrics(runA.id, batchOf(series('other', 0, 3), batchB));
    expect(result).toMatchObject({ accepted: 3, replayed: false });
  });
});

describe('project A cannot subscribe to project B', () => {
  test('opening B\'s stream is refused before any stream starts', async () => {
    const stream = await openStream(a.secret, runB.id);
    expect(stream.status).toBe(404);
    expect(stream.headers.get('content-type')).toContain('application/json');
    const withCursor = await openStream(a.secret, runB.id, { after: 0, query: `?project_id=${b.projectId}` });
    expect(withCursor.status).toBe(404);
  });

  test('A\'s open stream carries nothing of B while B is writing', async () => {
    const mine = await openStream(a.secret, runA.id);
    const theirs = await openStream(b.secret, runB.id, { after: 1 });
    for (let i = 0; i < 20; i++) {
      await b.client.sendMetrics(runB.id, batchOf(series('b-secret-metric', 1000 + i * 5, 1005 + i * 5)));
    }
    await a.client.sendMetrics(runA.id, batchOf(series('loss', 10, 12)));
    await theirs.waitFor((s) => s.messages.length > 0 && s.rows().length >= 100, 5000, 'B to receive its own points');
    await mine.waitFor((s) => s.rows().some((r) => r[0] === 'loss' && r[1] === 11), 5000, 'A to receive its own points');
    await sleep(300);
    mine.close();
    theirs.close();
    const everythingASaw = mine.events.map((e) => e.data).join('\n');
    expect(everythingASaw).not.toContain('b-secret');
    expect(mine.rows().every((r) => r[0] === 'loss' || r[0] === 'other')).toBe(true);
    // The run state A receives describes A's run, not B's.
    const lastState = JSON.parse(mine.events.filter((e) => e.event === 'run').at(-1)!.data);
    // B's run is far ahead by now: head 21 and 110 points against A's 3 and 15.
    const own = await a.client.getRun(runA.id);
    expect(lastState.head).toBeLessThanOrEqual(own.head);
    expect(lastState.points).toBeLessThanOrEqual(own.points);
  });

  test('one project filling its stream allowance does not block another project', async () => {
    const hog = await newTenant('iso-hog');
    const run = await hog.client.createRun();
    const open = [];
    let refused = 0;
    for (let i = 0; i < 205; i++) {
      const s = await openStream(hog.secret, run.id);
      if (s.status === 429) refused++;
      else open.push(s);
    }
    expect(open.length).toBe(200);
    expect(refused).toBe(5);
    const other = await openStream(a.secret, runA.id);
    expect(other.status).toBe(200);
    other.close();
    for (const s of open) s.close();
  });
});

describe('project A cannot guess its way in', () => {
  test('ids are random UUIDs, so one id says nothing about the next', async () => {
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await a.client.createRun()).id);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Neighbouring ids of B's run lead nowhere, and answer like any other miss.
    const n = BigInt('0x' + runB.id.replaceAll('-', ''));
    for (const delta of [1n, -1n, 2n]) {
      const hex = (n + delta).toString(16).padStart(32, '0');
      const near = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      expect((await call(a.secret, 'GET', `/runs/${near}`)).status).toBe(404);
    }
  });

  test('ids that are not UUIDs, or try to smuggle SQL or paths, get the same 404', async () => {
    const reference = await call(a.secret, 'GET', `/runs/${uuidv4()}`);
    for (const id of ['1', 'null', `${runB.id}'--`, `${runB.id}%20or%201=1`, '..%2f..%2fproject', '%00', '*']) {
      const response = await call(a.secret, 'GET', `/runs/${id}`);
      expect(response.status, id).toBe(404);
      expect(response.text, id).toBe(reference.text);
    }
  });

  test('wrong, malformed, missing and revoked keys are all the same 401', async () => {
    const victim = await newTenant('iso-revoked');
    const extra = await victim.client.createKey('to revoke');
    await victim.client.revokeKey(extra.id);
    const answers = [
      await call(null, 'GET', '/runs'),
      await call('sk_' + 'A'.repeat(43), 'GET', '/runs'),
      await call('not-a-key', 'GET', '/runs'),
      await call(extra.secret, 'GET', '/runs'),
      await call(a.secret.slice(0, -1) + (a.secret.endsWith('A') ? 'B' : 'A'), 'GET', '/runs'),
    ];
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(answers.map((r) => r.text)).size).toBe(1);
    // An anonymous caller learns nothing about ids either.
    const anonymous = [await call(null, 'GET', `/runs/${runB.id}`), await call(null, 'GET', `/runs/${uuidv4()}`)];
    expect(anonymous.map((r) => r.status)).toEqual([401, 401]);
    expect(anonymous[0]!.text).toBe(anonymous[1]!.text);
  });
});

describe('nothing is shared through a cache', () => {
  test('every answer forbids storing it, and no validator is offered', async () => {
    const paths = ['/runs', `/runs/${runA.id}`, `/runs/${runA.id}/metrics`, '/keys', '/project', `/runs/${runB.id}`];
    for (const path of paths) {
      const response = await call(a.secret, 'GET', path);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(response.headers.get('etag'), path).toBeNull();
      expect(response.headers.get('last-modified'), path).toBeNull();
    }
    const stream = await openStream(a.secret, runA.id);
    expect(stream.headers.get('cache-control')).toBe('no-store');
    stream.close();
    const unauthorized = await call(null, 'GET', '/runs');
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');
  });

  test('the same URL through the web proxy gives each key its own data, in both orders', async () => {
    const through = async (secret: string) => {
      const response = await fetch(`${WEB_URL}/api/runs`, { headers: { authorization: `Bearer ${secret}` } });
      return { status: response.status, body: await response.text() };
    };
    let reachable = true;
    try {
      await fetch(`${WEB_URL}/api/healthz`);
    } catch {
      reachable = false;
    }
    if (!reachable) {
      console.log(`SKIPPED: the web proxy at ${WEB_URL} is not running, this check needs the compose stack`);
      return;
    }
    for (let round = 0; round < 3; round++) {
      const forA = await through(a.secret);
      const forB = await through(b.secret);
      const anonymous = await fetch(`${WEB_URL}/api/runs`);
      expect(forA.body).toContain(runA.id);
      expect(forA.body).not.toContain(runB.id);
      expect(forB.body).toContain(runB.id);
      expect(forB.body).not.toContain(runA.id);
      expect(anonymous.status).toBe(401);
    }
  });

  test('a pooled database connection carries no project from the previous request', async () => {
    // Hammer both projects through the same small pool at once. If the project
    // setting leaked from one transaction into the next, lists would mix.
    const results: (readonly [number, { id: string }[]])[] = [];
    for (let wave = 0; wave < 20; wave++) {
      results.push(
        ...(await Promise.all(
          Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).client.listRuns().then((r) => [i % 2, r.runs] as const)),
        )),
      );
    }
    for (const [isA, runs] of results) {
      const ids = runs.map((r) => r.id);
      if (isA) expect(ids).not.toContain(runB.id);
      else expect(ids).toEqual([runB.id]);
    }
    const idle = new pg.Client({ connectionString: APP_DATABASE_URL });
    await idle.connect();
    const setting = await idle.query("select current_setting('app.project_id', true) as v");
    expect(setting.rows[0].v ?? '').toBe('');
    await idle.end();
  });
});

describe('the database itself refuses, even if the application forgets', () => {
  let app: pg.Client;

  beforeAll(async () => {
    app = new pg.Client({ connectionString: APP_DATABASE_URL });
    await app.connect();
  });
  afterAll(() => app.end());

  const asProject = async <T>(projectId: string | null, fn: () => Promise<T>): Promise<T> => {
    await app.query('begin');
    try {
      if (projectId) await app.query("select set_config('app.project_id', $1, true)", [projectId]);
      return await fn();
    } finally {
      await app.query('rollback');
    }
  };

  test('the application role is not a superuser, owns no tables and cannot bypass row security', async () => {
    const role = await app.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await app.query("select count(*) from pg_tables where tableowner = current_user and schemaname = 'public'");
    expect(Number(owned.rows[0].count)).toBe(0);
    const tables = await app.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('projects', 'api_keys', 'runs', 'batches', 'points') order by relname`,
    );
    expect(tables.rows).toHaveLength(5);
    for (const table of tables.rows) {
      expect(table, table.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  test('a query with no WHERE at all returns only the current project', async () => {
    for (const table of ['projects', 'api_keys', 'runs', 'batches', 'points']) {
      const column = table === 'projects' ? 'id' : 'project_id';
      const seen = await asProject(a.projectId, () => app.query(`select distinct ${column} as p from ${table}`));
      expect(seen.rows.map((r) => r.p), table).toEqual([a.projectId]);
    }
  });

  test('with no project set, every table is empty', async () => {
    for (const table of ['projects', 'api_keys', 'runs', 'batches', 'points']) {
      const seen = await asProject(null, () => app.query(`select count(*) from ${table}`));
      expect(Number(seen.rows[0].count), table).toBe(0);
    }
  });

  test('writes into another project are rejected or touch nothing', async () => {
    await expect(
      asProject(a.projectId, () =>
        app.query(
          `insert into points (run_id, project_id, key, step, value, seq) values ($1, $2, 'x', 0, 1, 99)`,
          [runB.id, b.projectId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Claiming B's run under A's project id fails the composite foreign key.
    await expect(
      asProject(a.projectId, () =>
        app.query(
          `insert into points (run_id, project_id, key, step, value, seq) values ($1, $2, 'x', 0, 1, 99)`,
          [runB.id, a.projectId],
        ),
      ),
    ).rejects.toThrow(/foreign key|row-level security/);
    const updated = await asProject(a.projectId, () =>
      app.query("update runs set name = 'taken' where id = $1", [runB.id]),
    );
    expect(updated.rowCount).toBe(0);
    await expect(
      asProject(a.projectId, () => app.query('update runs set project_id = $1 where id = $2', [b.projectId, runA.id])),
    ).rejects.toThrow(/row-level security/);
  });

  test('stored points cannot be changed or deleted by the application role at all', async () => {
    await expect(
      asProject(a.projectId, () => app.query('update points set value = 0 where run_id = $1', [runA.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asProject(a.projectId, () => app.query('delete from points where run_id = $1', [runA.id])),
    ).rejects.toThrow(/permission denied/);
    await expect(asProject(a.projectId, () => app.query('delete from runs'))).rejects.toThrow(/permission denied/);
  });

  test('the key lookup function is the only way across, and it returns nothing useful without a full hash', async () => {
    const guess = await app.query("select * from auth_lookup('\\x00'::bytea)");
    expect(guess.rowCount).toBe(0);
    await expect(app.query('select key_hash from api_keys')).resolves.toMatchObject({ rowCount: 0 });
  });
});

describe('what else could leak', () => {
  test('error bodies never echo ids, SQL, stack traces or key material', async () => {
    const bodies = [
      (await call(a.secret, 'GET', `/runs/${runB.id}`)).text,
      (await call(a.secret, 'POST', `/runs/${runB.id}/metrics`, { batch_id: batchB, points: [] })).text,
      (await call(a.secret, 'POST', `/runs/${runA.id}/metrics`, batchOf(series('x', 0, 1)), { 'x-test-fault': 'fail' })).text,
      (await call('sk_' + 'B'.repeat(43), 'GET', '/runs')).text,
      (await call(a.secret, 'GET', '/no/such/route')).text,
    ];
    for (const body of bodies) {
      expect(body).not.toMatch(/select |insert |points_pkey|at .*\.(ts|js)|node_modules|injected/i);
      expect(body).not.toContain(runB.id);
      expect(body).not.toContain(b.projectId);
      expect(body).not.toContain(a.secret);
    }
  });

  test('no response carries permissive cross-origin headers', async () => {
    const response = await call(a.secret, 'GET', '/runs', undefined, { origin: 'https://evil.example' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${API_URL}/runs`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('the API log contains no key, only key ids', async () => {
    if (!API_LOG_FILE) {
      console.log('SKIPPED: API_LOG_FILE is not set, this check needs the compose test stack');
      return;
    }
    const fresh = await newTenant('iso-log');
    const second = await fresh.client.createKey('log check');
    await fresh.client.rotateKey(second.id);
    await call(fresh.secret, 'GET', `/runs?token=${fresh.secret.slice(0, 6)}`);
    await sleep(300);
    const log = readFileSync(API_LOG_FILE, 'utf8');
    expect(log.length).toBeGreaterThan(1000);
    for (const secret of [a.secret, b.secret, fresh.secret, second.secret]) {
      expect(log.includes(secret)).toBe(false);
      // Not even the part after the public prefix.
      expect(log.includes(secret.slice(12))).toBe(false);
    }
    expect(log).toContain(fresh.keyId);
    expect(log).not.toMatch(/"authorization"/i);
    expect(log).not.toMatch(/Bearer /);
  });
});
