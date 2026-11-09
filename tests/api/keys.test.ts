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
    expect(new Set(statuses)).toEqual(new Set([200, 401]));
    // Every accepted write is stored whole, every refused one left nothing.
    const accepted = statuses.filter((s) => s === 200).length;
    expect((await fresh.getRun(run.id)).points).toBe(accepted * 10);
    console.log(`${accepted} writes accepted before the revocation, ${60 - accepted} refused after it`);
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
