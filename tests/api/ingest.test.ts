import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiError, uuidv4, type Run } from '@simmer/sdk';
import { API_URL } from '../lib/env.ts';
import {
  batchOf,
  closeOwner,
  invariantViolations,
  newTenant,
  owner,
  rowsText,
  series,
  storedPoints,
  type Tenant,
} from '../lib/helpers.ts';

let t: Tenant;
const touched: string[] = [];

async function newRun(): Promise<Run> {
  const run = await t.client.createRun();
  touched.push(run.id);
  return run;
}

async function rejects(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected the request to be rejected');
}

beforeAll(async () => {
  t = await newTenant('ingest');
});

afterAll(async () => {
  expect(await invariantViolations(touched)).toEqual([]);
  await closeOwner();
});

describe('the same batch sent again', () => {
  test('same batch_id and content returns the first answer and stores nothing new', async () => {
    const run = await newRun();
    const batch = batchOf(series('loss', 0, 10));
    const first = await t.client.sendMetrics(run.id, batch);
    expect(first).toMatchObject({ seq: 1, accepted: 10, duplicates: 0, conflicts: [], replayed: false });

    const second = await t.client.sendMetrics(run.id, batch);
    expect(second).toEqual({ ...first, replayed: true });

    const after = await t.client.getRun(run.id);
    expect(after).toMatchObject({ head: 1, points: 10 });
    expect(await storedPoints(run.id)).toHaveLength(10);
  });

  test('the content hash ignores the order points are listed in', async () => {
    const run = await newRun();
    const batch = batchOf(series('loss', 0, 5));
    await t.client.sendMetrics(run.id, batch);
    const reordered = { ...batch, points: [...batch.points].reverse() };
    expect((await t.client.sendMetrics(run.id, reordered)).replayed).toBe(true);
  });

  test('same batch_id with different content is refused with 409', async () => {
    const run = await newRun();
    const id = uuidv4();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5), id));
    const error = await rejects(t.client.sendMetrics(run.id, batchOf(series('loss', 5, 10), id)));
    expect(error.status).toBe(409);
    expect(error.code).toBe('batch_id_reused');
    expect(await storedPoints(run.id)).toHaveLength(5);
  });

  test('a new batch_id carrying already stored points counts them as duplicates', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 10)));
    const overlap = await t.client.sendMetrics(run.id, batchOf(series('loss', 5, 15)));
    expect(overlap).toMatchObject({ seq: 2, accepted: 5, duplicates: 5, conflicts: [] });

    const pureRepeat = await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 15)));
    expect(pureRepeat).toMatchObject({ seq: null, accepted: 0, duplicates: 15 });
    expect((await t.client.getRun(run.id)).head).toBe(2);
  });

  test('a different value for a stored point is a conflict and the first value stays', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf([{ key: 'loss', step: 3, value: 0.5 }]));
    const result = await t.client.sendMetrics(
      run.id,
      batchOf([
        { key: 'loss', step: 3, value: 0.9 },
        { key: 'loss', step: 4, value: 0.4 },
      ]),
    );
    expect(result).toMatchObject({ accepted: 1, duplicates: 0, conflicts: [{ key: 'loss', step: 3 }] });
    expect(rowsText(await storedPoints(run.id))).toEqual(['loss 3 0.5', 'loss 4 0.4']);
    expect((await t.client.getRun(run.id)).conflicts).toBe(1);
  });
});

describe('what a batch may contain', () => {
  test('steps may arrive in any order, storage is by step', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf(series('acc', 20, 30)));
    await t.client.sendMetrics(run.id, batchOf(series('acc', 0, 10)));
    await t.client.sendMetrics(run.id, batchOf(series('acc', 10, 20).reverse()));
    const steps = (await storedPoints(run.id)).map((r) => r[1]);
    expect(steps).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  test('NaN and infinities survive the round trip', async () => {
    const run = await newRun();
    await t.client.sendMetrics(
      run.id,
      batchOf([
        { key: 'loss', step: 0, value: NaN },
        { key: 'loss', step: 1, value: Infinity },
        { key: 'loss', step: 2, value: -Infinity },
        { key: 'loss', step: 3, value: 1e-300 },
        { key: 'loss', step: 4, value: 0.1 + 0.2 },
      ]),
    );
    expect(rowsText(await storedPoints(run.id))).toEqual([
      'loss 0 NaN',
      'loss 1 Infinity',
      'loss 2 -Infinity',
      'loss 3 1e-300',
      `loss 4 ${0.1 + 0.2}`,
    ]);
    const page = await t.client.getMetrics(run.id);
    expect(page.points.slice(0, 3).map((p) => p[2])).toEqual(['NaN', 'Infinity', '-Infinity']);
    // NaN sent again is the same value, not a conflict.
    const again = await t.client.sendMetrics(run.id, batchOf([{ key: 'loss', step: 0, value: NaN }]));
    expect(again).toMatchObject({ duplicates: 1, conflicts: [] });
  });

  test.each([
    ['no batch_id', { points: [{ key: 'a', step: 0, value: 1 }] }],
    ['batch_id that is not a UUID', { batch_id: 'one', points: [{ key: 'a', step: 0, value: 1 }] }],
    ['empty points', { batch_id: uuidv4(), points: [] }],
    ['a fractional step', { batch_id: uuidv4(), points: [{ key: 'a', step: 1.5, value: 1 }] }],
    ['a negative step', { batch_id: uuidv4(), points: [{ key: 'a', step: -1, value: 1 }] }],
    ['a step beyond 2^53', { batch_id: uuidv4(), points: [{ key: 'a', step: 2 ** 60, value: 1 }] }],
    ['a null value', { batch_id: uuidv4(), points: [{ key: 'a', step: 0, value: null }] }],
    ['a string value', { batch_id: uuidv4(), points: [{ key: 'a', step: 0, value: '1' }] }],
    ['a key with a space', { batch_id: uuidv4(), points: [{ key: 'a b', step: 0, value: 1 }] }],
    [
      'one point twice with different values',
      { batch_id: uuidv4(), points: [{ key: 'a', step: 0, value: 1 }, { key: 'a', step: 0, value: 2 }] },
    ],
    ['1001 points', { batch_id: uuidv4(), points: series('a', 0, 1001) }],
  ])('%s is refused with 422 and stores nothing', async (_name, body) => {
    const run = await newRun();
    const error = await rejects(t.client.request('POST', `/runs/${run.id}/metrics`, body));
    expect(error.status).toBe(422);
    expect(await storedPoints(run.id)).toHaveLength(0);
    expect((await t.client.getRun(run.id)).head).toBe(0);
  });

  test('a body that is not JSON is refused with 400', async () => {
    const run = await newRun();
    const response = await fetch(`${API_URL}/runs/${run.id}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json' },
      body: '{"batch_id": ',
    });
    expect(response.status).toBe(400);
  });

  test('a body over the size limit is refused with 413', async () => {
    const run = await newRun();
    const response = await fetch(`${API_URL}/runs/${run.id}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ batch_id: uuidv4(), points: [], pad: 'x'.repeat(1_200_000) }),
    });
    expect(response.status).toBe(413);
  });
});

describe('partial writes', () => {
  const post = (runId: string, body: unknown, fault: string) =>
    fetch(`${API_URL}/runs/${runId}/metrics`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.secret}`,
        'content-type': 'application/json',
        'x-test-fault': fault,
      },
      body: JSON.stringify(body),
    });

  test('a failure after the writes and before commit leaves no trace, and the retry succeeds', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    const batch = batchOf([...series('loss', 5, 505), ...series('acc', 0, 400)]);

    const failed = await post(run.id, batch, 'fail');
    expect(failed.status).toBe(500);
    const body = await failed.json();
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('injected');

    // Not one of the 900 points, no batch record, and seq 2 was not used up.
    expect(await storedPoints(run.id)).toHaveLength(5);
    const records = await owner().query('select count(*) from batches where run_id = $1', [run.id]);
    expect(Number(records.rows[0].count)).toBe(1);
    expect(await t.client.getRun(run.id)).toMatchObject({ head: 1, points: 5 });

    const retry = await t.client.sendMetrics(run.id, batch);
    expect(retry).toMatchObject({ seq: 2, accepted: 900, replayed: false });
    expect(await invariantViolations([run.id])).toEqual([]);
  });

  test('a database connection killed in the middle of a batch rolls the batch back', async () => {
    const run = await newRun();
    const batch = batchOf(series('loss', 0, 300));
    const pending = post(run.id, batch, 'delay:1500');
    // Find the backend that is holding the run row and kill it mid-transaction.
    let killed = 0;
    for (let i = 0; i < 100 && killed === 0; i++) {
      const found = await owner().query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where usename = 'simmer_app' and state = 'idle in transaction'`,
      );
      killed = found.rowCount ?? 0;
      if (killed === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(killed).toBeGreaterThan(0);
    expect((await pending).status).toBe(500);
    expect(await storedPoints(run.id)).toHaveLength(0);
    expect((await t.client.getRun(run.id)).head).toBe(0);

    // The pool recovers and the same batch goes through.
    const retry = await t.client.sendMetrics(run.id, batch);
    expect(retry).toMatchObject({ seq: 1, accepted: 300 });
  });
});
