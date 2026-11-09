import { afterAll, describe, expect, test } from 'vitest';
import { ApiError, Client } from '@simmer/sdk';
import { API_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, openStream, owner, series, sleep } from '../lib/helpers.ts';

afterAll(closeOwner);

const status = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};

describe('an old key after rotation', () => {
  test('stops working for every kind of request the moment the rotation answers', async () => {
    const t = await newTenant('rotate');
    const run = await t.client.createRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));

    const rotated = await t.client.rotateKey(t.keyId);
    // No sleep here on purpose: the very next requests must already fail.
    const old = t.client;
    const results = await Promise.all([
      status(old.listRuns()),
      status(old.getRun(run.id)),
      status(old.sendMetrics(run.id, batchOf(series('loss', 5, 10)))),
      status(old.getMetrics(run.id)),
      status(old.listKeys()),
      status(old.createKey('sneaky')),
      status(old.rotateKey(rotated.id)),
      openStream(t.secret, run.id).then((s) => s.status),
    ]);
    expect(results).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);

    const fresh = new Client({ baseUrl: API_URL, apiKey: rotated.secret });
    expect((await fresh.getRun(run.id)).points).toBe(5);
    const keys = (await fresh.listKeys()).keys;
    expect(keys.filter((k) => k.revoked_at === null).map((k) => k.id)).toEqual([rotated.id]);
    expect(keys.find((k) => k.id === rotated.id)?.current).toBe(true);
  });

  test('a stream opened with the old key is closed by the server, not left running', async () => {
    const t = await newTenant('rotate-stream');
    const run = await t.client.createRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');

    const rotated = await t.client.rotateKey(t.keyId);
    const rotatedAt = Date.now();
    await stream.waitFor((s) => s.ended, 2000, 'the old stream to end');
    console.log(`stream closed ${Date.now() - rotatedAt} ms after rotation`);
    expect(stream.events.at(-1)).toMatchObject({ event: 'bye', data: '{"reason":"key_revoked"}' });

    // Data written after the rotation never reached the old stream.
    const fresh = new Client({ baseUrl: API_URL, apiKey: rotated.secret });
    await fresh.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    await sleep(300);
    expect(stream.messages).toHaveLength(0);
  });

  test('if the revocation signal is lost, the stream still dies at the next heartbeat', async () => {
    const t = await newTenant('rotate-silent');
    await t.client.createKey('survivor');
    const run = await t.client.createRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    // Revoked directly in the table: no pg_notify, as if the signal was dropped.
    await owner().query('update api_keys set revoked_at = now() where id = $1', [t.keyId]);
    const revokedAt = Date.now();
    await stream.waitFor((s) => s.ended, 8000, 'the stream to end at a heartbeat');
    console.log(`stream closed ${Date.now() - revokedAt} ms after a revocation with no signal`);
    expect(stream.events.at(-1)?.event).toBe('bye');
  });

  test('a key revoked in the middle of a burst of writes cuts the burst cleanly', async () => {
    const t = await newTenant('rotate-burst');
    const second = await t.client.createKey('second');
    const run = await t.client.createRun();
    const writes = Array.from({ length: 60 }, (_, i) =>
      sleep(i * 3).then(() =>
        status(t.client.sendMetrics(run.id, batchOf(series('loss', i * 10, i * 10 + 10)))),
      ),
    );
    await sleep(60);
    const fresh = new Client({ baseUrl: API_URL, apiKey: second.secret });
    await fresh.revokeKey(t.keyId);
    const lateStatus = await status(t.client.sendMetrics(run.id, batchOf(series('late', 0, 1))));
    const statuses = await Promise.all(writes);
    expect(lateStatus).toBe(401);
    // While the revocation waits for writes in progress, later ones queue
    // behind it and some are turned away as "project busy" (429) first.
    expect(statuses).toContain(200);
    expect(statuses).toContain(401);
    expect(statuses.every((s) => s === 200 || s === 401 || s === 429)).toBe(true);
    // Every accepted write is stored whole, every refused one left nothing.
    const accepted = statuses.filter((s) => s === 200).length;
    expect((await fresh.getRun(run.id)).points).toBe(accepted * 10);
    console.log(`${accepted} writes accepted before the revocation, ${60 - accepted} refused after it`);
  });
});

describe('a write that races a revocation', () => {
  const post = (secret: string, runId: string, body: unknown, fault: string) =>
    fetch(`${API_URL}/runs/${runId}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-test-fault': fault },
      body: JSON.stringify(body),
    });

  test('a request that passed the key check before the revocation is refused when it reaches the database', async () => {
    const t = await newTenant('race-late');
    const run = await t.client.createRun();
    // The request is accepted at the door, then held for 500 ms before its transaction starts.
    const held = post(t.secret, run.id, batchOf(series('loss', 0, 10)), 'pause:500');
    await sleep(150);
    const rotated = await t.client.rotateKey(t.keyId);
    const response = await held;
    expect(response.status).toBe(401);
    const fresh = new Client({ baseUrl: API_URL, apiKey: rotated.secret });
    expect((await fresh.getRun(run.id)).points).toBe(0);
  });

  test('a revocation waits for a write that is already inside its transaction', async () => {
    const t = await newTenant('race-early');
    const run = await t.client.createRun();
    // This write has stored its points and sits 700 ms before commit.
    const writing = post(t.secret, run.id, batchOf(series('loss', 0, 10)), 'delay:700');
    await sleep(200);
    const startedAt = Date.now();
    const rotated = await t.client.rotateKey(t.keyId);
    const waited = Date.now() - startedAt;
    console.log(`rotation waited ${waited} ms for the write in progress`);
    expect((await writing).status).toBe(200);
    expect(waited).toBeGreaterThan(300);
    // So when the rotation answers, nothing from the old key is still on its way in.
    const fresh = new Client({ baseUrl: API_URL, apiKey: rotated.secret });
    expect((await fresh.getRun(run.id)).points).toBe(10);
    expect(await status(t.client.sendMetrics(run.id, batchOf(series('loss', 10, 20))))).toBe(401);
  });
});

describe('revoking a key that is in constant use', () => {
  test('the revocation is not held off by a steady stream of writes', async () => {
    const t = await newTenant('race-busy');
    const run = await t.client.createRun();
    let stop = false;
    let rotationAnsweredAt = Infinity;
    const acceptedAfter: number[] = [];
    let accepted = 0;
    let refused = 0;
    // Eight writers that never pause: there is always a write in progress.
    const writers = Array.from({ length: 8 }, async (_, w) => {
      for (let i = 0; !stop; i++) {
        const startedAt = Date.now();
        const code = await status(t.client.sendMetrics(run.id, batchOf(series(`w${w}`, i * 5, i * 5 + 5))));
        if (code === 200) {
          accepted++;
          if (startedAt > rotationAnsweredAt) acceptedAfter.push(startedAt - rotationAnsweredAt);
        } else refused++;
      }
    });
    await sleep(600);
    const startedAt = Date.now();
    await t.client.rotateKey(t.keyId);
    rotationAnsweredAt = Date.now();
    await sleep(600);
    stop = true;
    await Promise.all(writers);
    console.log(
      `rotation took ${rotationAnsweredAt - startedAt} ms under constant writes; ${accepted} writes accepted before it, ${refused} refused after`,
    );
    expect(rotationAnsweredAt - startedAt).toBeLessThan(500);
    // No write that started after the rotation answered got in.
    expect(acceptedAfter).toEqual([]);
    expect(refused).toBeGreaterThan(0);
  });
});

describe('key management', () => {
  test('the only active key cannot be revoked, so a project cannot lock itself out', async () => {
    const t = await newTenant('last-key');
    expect(await status(t.client.revokeKey(t.keyId))).toBe(409);
    const second = await t.client.createKey('second');
    expect(await status(t.client.revokeKey(second.id))).toBe(200);
    expect(await status(t.client.revokeKey(second.id))).toBe(404);
  });

  test('two keys revoking each other at the same time cannot both succeed', async () => {
    const t = await newTenant('mutual');
    const second = await t.client.createKey('second');
    const other = new Client({ baseUrl: API_URL, apiKey: second.secret });
    const outcomes = await Promise.all([
      status(t.client.revokeKey(second.id)),
      status(other.revokeKey(t.keyId)),
    ]);
    const active = await owner().query(
      'select count(*) from api_keys where project_id = $1 and revoked_at is null',
      [t.projectId],
    );
    console.log(`mutual revocation outcomes: ${outcomes.join(', ')}`);
    expect(Number(active.rows[0].count)).toBe(1);
  });

  test('a key is shown once and only its hash is stored', async () => {
    const t = await newTenant('hash');
    const listed = JSON.stringify(await t.client.listKeys());
    expect(listed).not.toContain(t.secret);
    expect(listed).not.toContain('secret');
    const row = await owner().query('select key_hash, prefix from api_keys where id = $1', [t.keyId]);
    expect(row.rows[0].key_hash).toHaveLength(32);
    expect(t.secret.startsWith(row.rows[0].prefix)).toBe(true);
    const everything = await owner().query('select to_jsonb(k)::text as row from api_keys k where id = $1', [
      t.keyId,
    ]);
    expect(everything.rows[0].row).not.toContain(t.secret.slice(12));
  });
});
