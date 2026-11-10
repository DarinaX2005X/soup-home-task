import { afterAll, describe, expect, test } from 'vitest';
import { API2_URL, API_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, series, sleep } from '../lib/helpers.ts';

afterAll(closeOwner);

describe('one project cannot starve the others', () => {
  test('a flood of slow writes from one project leaves another project fast', async () => {
    const noisy = await newTenant('limit-noisy');
    const quiet = await newTenant('limit-quiet');
    const run = await noisy.client.createRun();
    await quiet.client.createRun();

    // 40 writes at once, each holding a database connection for a second.
    // The pool has 20 connections. Without a per-project allowance these
    // would take all of them and everyone else would wait.
    const flood = Array.from({ length: 40 }, (_, i) =>
      fetch(`${API_URL}/runs/${run.id}/metrics`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${noisy.secret}`,
          'content-type': 'application/json',
          'x-test-fault': 'delay:1000',
        },
        body: JSON.stringify(batchOf(series(`m${i}`, 0, 3))),
      }).then((response) => ({ status: response.status, retryAfter: response.headers.get('retry-after') })),
    );
    await sleep(150);

    const latencies: number[] = [];
    for (let i = 0; i < 15; i++) {
      const startedAt = performance.now();
      const runs = await quiet.client.listRuns();
      latencies.push(performance.now() - startedAt);
      expect(runs.runs).toHaveLength(1);
    }
    const worst = Math.max(...latencies);
    const answers = await Promise.all(flood);
    const accepted = answers.filter((a) => a.status === 200).length;
    const refused = answers.filter((a) => a.status === 429);
    console.log(
      `noisy project: ${accepted} accepted, ${refused.length} refused with 429; quiet project's slowest request meanwhile: ${worst.toFixed(0)} ms`,
    );
    expect(accepted).toBe(12);
    expect(refused).toHaveLength(28);
    expect(refused.every((a) => a.retryAfter === '1')).toBe(true);
    expect(worst).toBeLessThan(300);
    // The refused writes left nothing behind, and the allowance is free again.
    expect((await noisy.client.getRun(run.id)).points).toBe(36);
    expect((await noisy.client.sendMetrics(run.id, batchOf(series('after', 0, 1)))).accepted).toBe(1);
  });

  test('hanging up does not give the allowance back while the work is still running', async () => {
    const noisy = await newTenant('limit-hangup');
    const run = await noisy.client.createRun();
    const slowWrite = (signal?: AbortSignal) =>
      fetch(`${API_URL}/runs/${run.id}/metrics`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${noisy.secret}`,
          'content-type': 'application/json',
          'x-test-fault': 'delay:1200',
        },
        body: JSON.stringify(batchOf(series(`m${Math.random().toString(36).slice(2, 8)}`, 0, 2))),
        signal,
      }).then(
        (response) => response.status,
        () => 0,
      );
    // Twelve slow writes fill the allowance. The client then drops every
    // connection, while the server is still inside all twelve transactions.
    const controller = new AbortController();
    const first = Array.from({ length: 12 }, () => slowWrite(controller.signal));
    await sleep(200);
    controller.abort();
    await Promise.all(first);
    await sleep(100);
    const second = await Promise.all(Array.from({ length: 12 }, () => slowWrite()));
    console.log(`after hanging up on 12 writes in progress, 12 more got: ${[...new Set(second)].join(', ')}`);
    expect(second.every((status) => status === 429)).toBe(true);
    // Once the abandoned work has finished, the allowance is back.
    await sleep(1300);
    expect(await slowWrite()).toBe(200);
  });
});

describe('key management under a flood', () => {
  test('a project at its allowance can still revoke the key that is flooding it', async () => {
    const t = await newTenant('limit-revoke');
    const admin = await t.client.createKey('admin');
    const run = await t.client.createRun();
    const slow = () =>
      fetch(`${API_URL}/runs/${run.id}/metrics`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json', 'x-test-fault': 'delay:1500' },
        body: JSON.stringify(batchOf(series(`m${Math.random().toString(36).slice(2, 8)}`, 0, 2))),
      }).then((r) => r.status);
    const flood = Array.from({ length: 30 }, slow);
    await sleep(200);
    const call = (method: string, path: string) =>
      fetch(API_URL + path, { method, headers: { authorization: `Bearer ${admin.secret}` } }).then((r) => r.status);
    // The general allowance is full: an ordinary request is turned away.
    expect(await call('GET', '/runs')).toBe(429);
    // Revocation has its own. It waits for the writes in progress, then answers.
    expect(await call('DELETE', `/keys/${t.keyId}`)).toBe(204);
    await Promise.all(flood);
    expect(await slow()).toBe(401);
  });

  test('with the allowance full, the key list can still be read, and creating keys cannot be used as a side door', async () => {
    const t = await newTenant('limit-keys');
    const run = await t.client.createRun();
    const flood = Array.from({ length: 12 }, () =>
      fetch(`${API_URL}/runs/${run.id}/metrics`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json', 'x-test-fault': 'delay:800' },
        body: JSON.stringify(batchOf(series(`m${Math.random().toString(36).slice(2, 8)}`, 0, 2))),
      }),
    );
    await sleep(200);
    const headers = { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json' };
    const statuses = await Promise.all([
      fetch(`${API_URL}/keys`, { headers }).then((r) => r.status),
      fetch(`${API_URL}/keys`, { method: 'POST', headers, body: '{}' }).then((r) => r.status),
    ]);
    expect(statuses).toEqual([200, 429]);
    await Promise.all(flood);
  });

  test('one key filling its key-management allowance does not block another key from revoking it', async () => {
    const t = await newTenant('limit-lanes');
    const leaked = await t.client.createKey('leaked');
    const victim = await t.client.createKey('victim');
    const run = await t.client.createRun();
    const as = (secret: string, method: string, path: string, fault?: string, body?: unknown) =>
      fetch(API_URL + path, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(fault ? { 'x-test-fault': fault } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.status);
    // A slow write with the victim key is in progress, so revoking that key has to wait for it.
    const slowWrite = as(victim.secret, 'POST', `/runs/${run.id}/metrics`, 'delay:1500', batchOf(series('m', 0, 2)));
    await sleep(200);
    // The leaked key starts two revocations of it. Both wait, and fill the leaked key's own lane.
    const stuck = [as(leaked.secret, 'DELETE', `/keys/${victim.id}`), as(leaked.secret, 'DELETE', `/keys/${victim.id}`)];
    await sleep(200);
    expect(await as(leaked.secret, 'GET', '/keys')).toBe(429);
    // The owner's key has a lane of its own: it reads the list at once, and
    // its revocation of the leaked key gets through. Revocations run one
    // after another, so it waits for the one already in progress.
    expect(await as(t.secret, 'GET', '/keys')).toBe(200);
    expect(await as(t.secret, 'DELETE', `/keys/${leaked.id}`)).toBe(204);
    expect(await slowWrite).toBe(200);
    // The leaked key was still valid when its first revocation ran, so that
    // one succeeded: any key of a project may revoke another, and this design
    // does not prevent it. The second found the victim already revoked.
    expect((await Promise.all(stuck)).sort()).toEqual([204, 404]);
    // From here on the leaked key is dead.
    expect(await as(leaked.secret, 'GET', '/keys')).toBe(401);
    expect(await as(leaked.secret, 'DELETE', `/keys/${t.keyId}`)).toBe(401);
    expect(await as(t.secret, 'GET', '/runs')).toBe(200);
  });

  test('many keys cannot add their key-management allowances up past the project-wide one', async () => {
    const t = await newTenant('limit-sum');
    const victim = await t.client.createKey('victim');
    const others = [];
    for (let i = 0; i < 4; i++) others.push(await t.client.createKey(`k${i}`));
    const run = await t.client.createRun();
    const as = (secret: string, method: string, path: string) =>
      fetch(API_URL + path, { method, headers: { authorization: `Bearer ${secret}` } }).then((r) => r.status);
    // A slow write with the victim key makes every revocation of it wait.
    const slowWrite = fetch(`${API_URL}/runs/${run.id}/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${victim.secret}`, 'content-type': 'application/json', 'x-test-fault': 'delay:1500' },
      body: JSON.stringify(batchOf(series('m', 0, 2))),
    });
    await sleep(200);
    // Three keys, two waiting revocations each: six in progress for the project.
    const waiting = others.slice(0, 3).flatMap((k) => [
      as(k.secret, 'DELETE', `/keys/${victim.id}`),
      as(k.secret, 'DELETE', `/keys/${victim.id}`),
    ]);
    await sleep(200);
    // A fourth key has its own lane free, but the project-wide one is full.
    expect(await as(others[3]!.secret, 'GET', '/keys')).toBe(429);
    await slowWrite;
    const done = await Promise.all(waiting);
    expect(done.filter((s) => s === 204)).toHaveLength(1);
    expect(await as(others[3]!.secret, 'GET', '/keys')).toBe(200);
  });

  test('a project cannot pile up keys without end', async () => {
    const t = await newTenant('limit-count');
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      statuses.push(
        await fetch(`${API_URL}/keys`, {
          method: 'POST',
          headers: { authorization: `Bearer ${t.secret}`, 'content-type': 'application/json' },
          body: '{}',
        }).then((r) => r.status),
      );
    }
    // One key came with the project, so 19 more fit.
    expect(statuses.filter((s) => s === 201)).toHaveLength(19);
    expect(statuses.slice(19)).toEqual([409, 409]);
  });
});

describe.skipIf(!API2_URL)('creating projects on a locked-down instance', () => {
  const create = (headers: Record<string, string> = {}) =>
    fetch(`${API2_URL}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'invited' }),
    });

  test('the instance says what it needs before anyone has a key', async () => {
    expect(await (await fetch(`${API2_URL}/config`)).json()).toEqual({ signup: 'token' });
    expect(await (await fetch(`${API_URL}/config`)).json()).toEqual({ signup: 'open' });
  });

  test('without the invite code no project is created', async () => {
    const answers = [await create(), await create({ 'x-signup-token': 'guess' }), await create({ 'x-signup-token': '' })];
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403]);
    expect((await answers[0]!.json()).error.code).toBe('signup_closed');
  });

  test('with the code, one address gets four projects an hour, whatever address it claims to be', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // A different made-up X-Forwarded-For every time. This instance is
      // reached directly, not through its proxy, so the header is not believed.
      const claimed = { 'x-signup-token': 'test-invite-code', 'x-forwarded-for': `203.0.113.${i + 1}` };
      statuses.push((await create(claimed)).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 429, 429]);
  });
});
