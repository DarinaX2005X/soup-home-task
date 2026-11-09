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
