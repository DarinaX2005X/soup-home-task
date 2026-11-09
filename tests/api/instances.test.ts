import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client, sendBatch } from '@simmer/sdk';
import { API2_URL, API_URL } from '../lib/env.ts';
import {
  assertChain,
  batchOf,
  closeOwner,
  newTenant,
  openStream,
  owner,
  rowsText,
  series,
  sortRows,
  storedPoints,
  type Tenant,
} from '../lib/helpers.ts';

// Two API processes share one database. Writes go to the first, live streams
// are read from the second, so the only thing connecting them is Postgres.
describe.skipIf(!API2_URL)('two API instances', () => {
  let t: Tenant;
  const second = API2_URL!;

  beforeAll(async () => {
    t = await newTenant('instances');
  });
  afterAll(closeOwner);

  test('a batch written through one instance reaches a stream on the other within a second', async () => {
    const run = await t.client.createRun();
    const stream = await openStream(t.secret, run.id, { baseUrl: second });
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    const sentAt = Date.now();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    await stream.waitFor((s) => s.messages.at(-1)?.to === 1, 1000, 'delivery across instances within 1 s');
    console.log(`delivered across instances in ${Date.now() - sentAt} ms`);
    stream.close();
  });

  test('100 concurrent batches through one instance arrive whole on both', async () => {
    const run = await t.client.createRun();
    const here = await openStream(t.secret, run.id);
    const there = await openStream(t.secret, run.id, { baseUrl: second });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => sendBatch(t.client, run.id, batchOf(series(`m${i % 4}`, i * 5, i * 5 + 5)))),
    );
    for (const stream of [here, there]) {
      await stream.waitFor((s) => s.messages.at(-1)?.to === 100, 5000, 'cursor 100');
      stream.close();
      expect(assertChain(stream, 0)).toBe(100);
      expect(rowsText(sortRows(stream.rows()))).toEqual(rowsText(await storedPoints(run.id)));
    }
  });

  test('writes alternate between instances and seq stays one unbroken sequence', async () => {
    const run = await t.client.createRun();
    const other = new Client({ baseUrl: second, apiKey: t.secret });
    const stream = await openStream(t.secret, run.id, { baseUrl: second });
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => sendBatch(i % 2 ? t.client : other, run.id, batchOf(series('loss', i * 3, i * 3 + 3)))),
    );
    expect(results.map((r) => r.result.seq!).sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    await stream.waitFor((s) => s.messages.at(-1)?.to === 60, 5000, 'cursor 60');
    stream.close();
    expect(assertChain(stream, 0)).toBe(60);
  });

  test('finishing a run on one instance shows on the other at once', async () => {
    const run = await t.client.createRun();
    const stream = await openStream(t.secret, run.id, { baseUrl: second });
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    await t.client.finishRun(run.id);
    await stream.waitFor(
      (s) => s.events.some((e) => e.event === 'run' && JSON.parse(e.data).status === 'finished'),
      1000,
      'finished status within 1 s',
    );
    stream.close();
  });

  test('a key rotated on one instance closes its streams on the other and is refused there', async () => {
    const victim = await newTenant('instances-rotate');
    const run = await victim.client.createRun();
    const stream = await openStream(victim.secret, run.id, { baseUrl: second });
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    const rotatedAt = Date.now();
    await victim.client.rotateKey(victim.keyId);
    const refused = await fetch(`${second}/runs`, { headers: { authorization: `Bearer ${victim.secret}` } });
    expect(refused.status).toBe(401);
    await stream.waitFor((s) => s.ended, 2000, 'the stream on the other instance to end');
    console.log(`stream on the other instance closed ${Date.now() - rotatedAt} ms after rotation`);
    expect(stream.events.at(-1)?.event).toBe('bye');
  });

  test('with every notification listener killed, the other instance still delivers', async () => {
    const run = await t.client.createRun();
    const stream = await openStream(t.secret, run.id, { baseUrl: second });
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    const killed = await owner().query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where usename = 'simmer_app' and query ilike 'listen %'`,
    );
    expect(killed.rowCount).toBeGreaterThanOrEqual(2);
    const sentAt = Date.now();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    await stream.waitFor((s) => s.messages.at(-1)?.to === 1, 8000, 'delivery without a listener');
    console.log(`delivered across instances ${Date.now() - sentAt} ms after the write, with both listeners killed`);
    stream.close();
  });
});

test.skipIf(Boolean(API2_URL))('two API instances (skipped: no second instance in this stack)', () => {
  expect(API_URL).toBeTruthy();
});
