import http from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RunData, RunStream, SseParser, sendBatch, type Run } from '@simmer/sdk';
import { API_URL } from '../lib/env.ts';
import {
  assertChain,
  batchOf,
  closeOwner,
  invariantViolations,
  newTenant,
  openStream,
  owner,
  rng,
  rowsText,
  series,
  sleep,
  sortRows,
  storedPoints,
  type Row,
  type Tenant,
} from '../lib/helpers.ts';

let t: Tenant;
const touched: string[] = [];

async function newRun(): Promise<Run> {
  const run = await t.client.createRun();
  touched.push(run.id);
  return run;
}

async function stats(): Promise<{ rss: number; streams: number; stream_buffered_bytes: number }> {
  return (await fetch(`${API_URL}/_test/stats`)).json();
}

beforeAll(async () => {
  t = await newTenant('stream');
});

afterAll(async () => {
  expect(await invariantViolations(touched)).toEqual([]);
  await closeOwner();
});

describe('catch-up', () => {
  test('a reader that starts at zero receives the whole table as one unbroken chain', async () => {
    const run = await newRun();
    for (let i = 0; i < 20; i++) {
      await t.client.sendMetrics(run.id, batchOf(series('loss', i * 10, i * 10 + 10)));
    }
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.messages.at(-1)?.to === 20, 5000, 'cursor 20');
    stream.close();
    expect(assertChain(stream, 0)).toBe(20);
    expect(rowsText(sortRows(stream.rows()))).toEqual(rowsText(await storedPoints(run.id)));
  });

  test('a reader that resumes from a cursor receives exactly what came after it', async () => {
    const run = await newRun();
    for (let i = 0; i < 10; i++) {
      await t.client.sendMetrics(run.id, batchOf(series('loss', i * 5, i * 5 + 5)));
    }
    const stream = await openStream(t.secret, run.id, { after: 7 });
    await stream.waitFor((s) => s.messages.at(-1)?.to === 10, 5000, 'cursor 10');
    stream.close();
    expect(stream.messages[0]!.from).toBe(7);
    expect(assertChain(stream, 7)).toBe(10);
    expect(sortRows(stream.rows()).map((r) => r[1])).toEqual(
      Array.from({ length: 15 }, (_, i) => 35 + i),
    );
  });

  test('the cursor is also accepted as ?after=, for clients that cannot set headers', async () => {
    const run = await newRun();
    for (let i = 0; i < 3; i++) await t.client.sendMetrics(run.id, batchOf(series('loss', i, i + 1)));
    const stream = await openStream(t.secret, run.id, { query: '?after=2' });
    await stream.waitFor((s) => s.messages.length > 0, 5000, 'first message');
    stream.close();
    expect(stream.messages[0]).toMatchObject({ from: 2, to: 3 });
  });

  test('a cursor ahead of the server gets a reset and then everything from zero', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 4)));
    const stream = await openStream(t.secret, run.id, { after: 999 });
    await stream.waitFor((s) => s.messages.length > 0, 5000, 'replay after reset');
    stream.close();
    const kinds = stream.events.map((e) => e.event);
    expect(kinds.indexOf('reset')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('reset')).toBeLessThan(kinds.indexOf('points'));
    expect(stream.messages[0]).toMatchObject({ from: 0, to: 1 });
  });

  test.each(['-1', 'abc', '1.5', '99999999999999999999'])('cursor %s is refused', async (cursor) => {
    const run = await newRun();
    const response = await fetch(`${API_URL}/runs/${run.id}/events`, {
      headers: { authorization: `Bearer ${t.secret}`, 'last-event-id': cursor },
    });
    expect(response.status).toBe(422);
  });
});

describe('live delivery', () => {
  test('a batch reaches an open stream without waiting for the heartbeat', async () => {
    const run = await newRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    const sentAt = Date.now();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 3)));
    await stream.waitFor((s) => s.messages.length === 1, 1000, 'live message within 1 s');
    console.log(`live delivery took ${Date.now() - sentAt} ms from request start`);
    stream.close();
  });

  test('finishing a run reaches an open stream at once', async () => {
    const run = await newRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    await t.client.finishRun(run.id, 'failed');
    await stream.waitFor(
      (s) => s.events.some((e) => e.event === 'run' && JSON.parse(e.data).status === 'failed'),
      1000,
      'failed status within 1 s',
    );
    stream.close();
  });

  test('30 batches written concurrently to one run arrive as an unbroken chain', async () => {
    const run = await newRun();
    const stream = await openStream(t.secret, run.id);
    await Promise.all(
      // sendBatch retries when the project's allowance of concurrent requests is full.
      Array.from({ length: 30 }, (_, i) =>
        sendBatch(t.client, run.id, batchOf(series(`m${i % 3}`, i * 10, i * 10 + 10))),
      ),
    );
    await stream.waitFor((s) => s.messages.at(-1)?.to === 30, 5000, 'cursor 30');
    stream.close();
    expect(assertChain(stream, 0)).toBe(30);
    expect(rowsText(sortRows(stream.rows()))).toEqual(rowsText(await storedPoints(run.id)));
  });

  test('a batch that commits slowly holds back later ones, so no seq is ever visible out of order', async () => {
    const run = await newRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    // Batch A takes seq 1 and then sits before commit for 700 ms.
    const slow = fetch(`${API_URL}/runs/${run.id}/metrics`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.secret}`,
        'content-type': 'application/json',
        'x-test-fault': 'delay:700',
      },
      body: JSON.stringify(batchOf(series('a', 0, 5))),
    });
    await sleep(150);
    const fast = t.client.sendMetrics(run.id, batchOf(series('b', 0, 5)));
    // Meanwhile a second reader connects and reads. It must not get ahead.
    const during = await openStream(t.secret, run.id);
    await sleep(200);
    expect(during.messages).toHaveLength(0);
    expect(stream.messages).toHaveLength(0);

    const [, fastResult] = await Promise.all([slow, fast]);
    expect(fastResult.seq).toBe(2);
    await stream.waitFor((s) => s.messages.at(-1)?.to === 2, 3000, 'cursor 2');
    await during.waitFor((s) => s.messages.at(-1)?.to === 2, 3000, 'cursor 2');
    stream.close();
    during.close();
    expect(assertChain(stream, 0)).toBe(2);
    expect(assertChain(during, 0)).toBe(2);
    expect(stream.rows()[0]![0]).toBe('a');
  });
});

describe('events lost on reconnect', () => {
  test('a reader cut at random bytes 40 times during ingestion ends up equal to the table', async () => {
    const run = await newRun();
    const random = rng(20261110);
    let cuts = 0;
    // The real client, over a transport that severs the stream after a random
    // number of bytes. Cuts land between events and inside events alike.
    const flaky: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!response.body || cuts >= 40) return response;
      const budget = 200 + Math.floor(random() * 6000);
      let passed = 0;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          if (passed + value.length > budget) {
            controller.enqueue(value.slice(0, Math.max(budget - passed, 0)));
            cuts++;
            void reader.cancel();
            controller.error(new Error('cut by test'));
            return;
          }
          passed += value.length;
          controller.enqueue(value);
        },
        cancel: () => void reader.cancel(),
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };

    const data = new RunData();
    const reader = new RunStream({
      baseUrl: API_URL,
      apiKey: t.secret,
      runId: run.id,
      data,
      fetch: flaky,
      minDelayMs: 5,
      maxDelayMs: 40,
    }).start();

    const batches = Array.from({ length: 240 }, (_, i) =>
      batchOf([
        ...series('train/loss', i * 8, i * 8 + 8, (s) => 1 / (s + 1)),
        ...series('train/accuracy', i * 8, i * 8 + 8, (s) => s / 2000),
      ]),
    );
    const queue = [...batches];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let b = queue.shift(); b; b = queue.shift()) {
          await sendBatch(t.client, run.id, b);
          await sleep(Math.floor(random() * 15));
        }
      }),
    );

    const deadline = Date.now() + 20_000;
    while (data.cursor < 240 && Date.now() < deadline) await sleep(20);
    reader.stop();

    const snapshot = reader.snapshot;
    console.log(
      `cuts=${cuts} connects=${snapshot.connects} gaps=${snapshot.gaps} resyncs=${snapshot.resyncs} cursor=${data.cursor} points=${data.count}`,
    );
    expect(cuts).toBe(40);
    expect(data.cursor).toBe(240);
    // The view was built by resuming, never by starting over.
    expect(snapshot.resyncs).toBe(0);
    expect(snapshot.gaps).toBe(0);
    expect(rowsText([...data.points()] as Row[])).toEqual(rowsText(await storedPoints(run.id)));
  });

  test('a committed write that sends no notification at all is found by the heartbeat', async () => {
    const run = await newRun();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.messages.at(-1)?.to === 1, 5000, 'cursor 1');
    // Written straight into the tables, so nothing calls pg_notify. This is
    // what a dropped notification looks like from the stream's side.
    const db = await owner().connect();
    try {
      await db.query('begin');
      await db.query(
        `insert into points (run_id, project_id, key, step, value, seq) values ($1, $2, 'loss', 5, 0.25, 2)`,
        [run.id, t.projectId],
      );
      await db.query('update runs set last_seq = 2, point_count = point_count + 1 where id = $1', [run.id]);
      await db.query('commit');
    } finally {
      db.release();
    }
    const writtenAt = Date.now();
    await stream.waitFor((s) => s.messages.at(-1)?.to === 2, 8000, 'delivery by heartbeat');
    console.log(`delivered ${Date.now() - writtenAt} ms after a write with no notification`);
    stream.close();
    expect(assertChain(stream, 0)).toBe(2);
  });

  test('when the notification listener dies, batches written meanwhile still arrive', async () => {
    const run = await newRun();
    const stream = await openStream(t.secret, run.id);
    await stream.waitFor((s) => s.events.some((e) => e.event === 'run'), 5000, 'first run state');
    const killed = await owner().query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where usename = 'simmer_app' and query ilike 'listen %'`,
    );
    expect(killed.rowCount).toBeGreaterThan(0);
    const sentAt = Date.now();
    await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 5)));
    await stream.waitFor((s) => s.messages.at(-1)?.to === 1, 8000, 'delivery without a notification');
    console.log(`delivered ${Date.now() - sentAt} ms after the write, with the listener killed`);
    // And notifications work again afterwards.
    await sleep(1500);
    await t.client.sendMetrics(run.id, batchOf(series('loss', 5, 10)));
    await stream.waitFor((s) => s.messages.at(-1)?.to === 2, 1000, 'live delivery after listener recovery');
    stream.close();
  });
});

describe('a slow reader', () => {
  /** An SSE connection whose socket we can stop reading from. */
  function openPausable(runId: string) {
    const parser = new SseParser();
    const state = { points: 0, cursor: 0, chainOk: true, ended: false, res: undefined as http.IncomingMessage | undefined };
    const url = new URL(`${API_URL}/runs/${runId}/events`);
    const request = http.get(
      { host: url.hostname, port: url.port, path: url.pathname, headers: { authorization: `Bearer ${t.secret}` } },
      (res) => {
        state.res = res;
        res.pause();
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          for (const event of parser.feed(chunk)) {
            if (event.event !== 'points') continue;
            const message = JSON.parse(event.data);
            if (message.from !== state.cursor) state.chainOk = false;
            state.cursor = message.to;
            state.points += message.points.length;
          }
        });
        res.on('close', () => (state.ended = true));
      },
    );
    request.on('error', () => (state.ended = true));
    return { state, destroy: () => request.destroy() };
  }

  test('a reader that stops reading costs the server one page, then catches up completely', async () => {
    const run = await newRun();
    const before = await stats();
    const slow = openPausable(run.id);
    while (!slow.state.res) await sleep(10);

    // 200 000 points, about 5 MB on the wire, while the reader reads nothing.
    let peakBuffered = 0;
    let peakRss = 0;
    const sampler = setInterval(async () => {
      const s = await stats();
      peakBuffered = Math.max(peakBuffered, s.stream_buffered_bytes);
      peakRss = Math.max(peakRss, s.rss);
    }, 100);
    const queue = Array.from({ length: 200 }, (_, i) => i);
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
          await t.client.sendMetrics(run.id, batchOf(series(`k${i % 4}`, Math.floor(i / 4) * 1000, Math.floor(i / 4) * 1000 + 1000)));
        }
      }),
    );
    await sleep(500);
    clearInterval(sampler);
    const during = await stats();
    console.log(
      `while the reader was paused: peak buffered ${peakBuffered} bytes, rss ${Math.round(before.rss / 1e6)} MB before, peak ${Math.round(peakRss / 1e6)} MB`,
    );
    expect(during.streams).toBeGreaterThanOrEqual(1);
    // One page of 5000 points is about 150 KB of JSON. A queue of everything
    // would be about 5 MB.
    expect(peakBuffered).toBeLessThan(1_000_000);
    expect(slow.state.points).toBe(0);

    slow.state.res!.resume();
    const deadline = Date.now() + 30_000;
    while (slow.state.points < 200_000 && Date.now() < deadline) await sleep(50);
    slow.destroy();
    expect(slow.state.points).toBe(200_000);
    expect(slow.state.cursor).toBe(200);
    expect(slow.state.chainOk).toBe(true);
  });

  test('a reader that never reads again is cut off after the stall timeout', async () => {
    // The server only notices a reader that has stopped once the kernel's
    // socket buffers are full, and between two containers those hold several
    // megabytes. So this run is filled with about 20 MB of points, written
    // straight into the tables to keep the test short.
    const run = await newRun();
    await owner().query(
      `insert into points (run_id, project_id, key, step, value, seq)
       select $1, $2, 'k' || (g % 4), g / 4, g * 0.001, g / 1000 + 1 from generate_series(0, 799999) g`,
      [run.id, t.projectId],
    );
    await owner().query('update runs set last_seq = 800, point_count = 800000 where id = $1', [run.id]);
    const slow = openPausable(run.id);
    while (!slow.state.res) await sleep(10);
    const startedAt = Date.now();
    // The server only learns the socket is closed from its own side, so watch
    // its stream count rather than our end.
    const baseline = (await stats()).streams;
    expect(baseline).toBeGreaterThanOrEqual(1);
    let gone = false;
    while (Date.now() - startedAt < 45_000) {
      await sleep(500);
      if ((await stats()).streams < baseline) {
        gone = true;
        break;
      }
    }
    console.log(`stalled stream closed by the server after ${Date.now() - startedAt} ms`);
    slow.destroy();
    expect(gone).toBe(true);
  });
});
