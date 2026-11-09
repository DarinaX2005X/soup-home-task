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

  test('with the code, one address gets four projects an hour and then waits', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await create({ 'x-signup-token': 'test-invite-code' })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 429, 429]);
  });
});
