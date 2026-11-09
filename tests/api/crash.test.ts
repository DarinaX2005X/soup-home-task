import { afterAll, expect, test } from 'vitest';
import { RunData, RunStream, sendBatch } from '@simmer/sdk';
import { API_URL, CAN_CRASH_API } from '../lib/env.ts';
import {
  batchOf,
  closeOwner,
  invariantViolations,
  newTenant,
  rowsText,
  series,
  sleep,
  storedPoints,
  type Row,
} from '../lib/helpers.ts';

afterAll(closeOwner);

async function waitForApi(timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if ((await fetch(`${API_URL}/healthz`)).ok) return Date.now() - startedAt;
    } catch {
      // Still down.
    }
    await sleep(100);
  }
  throw new Error(`The API did not come back within ${timeoutMs} ms`);
}

// The API process is killed with every write of a batch done and the commit
// not yet sent. Compose restarts it. Skipped where nothing would restart it.
test.skipIf(!CAN_CRASH_API)(
  'the API process dying before commit loses the batch whole, and a reader resumes across the restart',
  async () => {
    const t = await newTenant('crash');
    const run = await t.client.createRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 50)));

    const data = new RunData();
    const reader = new RunStream({
      baseUrl: API_URL,
      apiKey: t.secret,
      runId: run.id,
      data,
      minDelayMs: 50,
      maxDelayMs: 500,
    }).start();
    while (data.cursor < 1) await sleep(20);

    const doomed = batchOf(series('loss', 50, 550));
    const crashed = await fetch(`${API_URL}/runs/${run.id}/metrics`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.secret}`,
        'content-type': 'application/json',
        'x-test-fault': 'crash',
      },
      body: JSON.stringify(doomed),
    }).then(
      (response) => `answered ${response.status}`,
      () => 'connection lost',
    );
    expect(crashed).toBe('connection lost');
    console.log(`API was back ${await waitForApi(30_000)} ms after the crash`);

    expect(await storedPoints(run.id)).toHaveLength(50);
    expect(await t.client.getRun(run.id)).toMatchObject({ head: 1, points: 50 });
    expect(await invariantViolations([run.id])).toEqual([]);

    // The client does what it always does: sends the same batch again.
    const { result } = await sendBatch(t.client, run.id, doomed);
    expect(result).toMatchObject({ seq: 2, accepted: 500, replayed: false });

    const deadline = Date.now() + 15_000;
    while (data.cursor < 2 && Date.now() < deadline) await sleep(50);
    reader.stop();
    console.log(`reader: connects=${reader.snapshot.connects} resyncs=${reader.snapshot.resyncs} cursor=${data.cursor}`);
    expect(reader.snapshot.connects).toBeGreaterThanOrEqual(2);
    expect(reader.snapshot.resyncs).toBe(0);
    expect(rowsText([...data.points()] as Row[])).toEqual(rowsText(await storedPoints(run.id)));
  },
);
