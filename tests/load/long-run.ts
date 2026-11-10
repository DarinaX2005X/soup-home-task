// What does opening the page of a long run cost?
//
// Two ways to open it, for a run the size of one day at the target rate
// (10 points per second for 24 hours = 864 000 points): reading every point
// from the stream, which is what the page did at first, and starting from the
// server's overview, which is what it does now above 50 000 points.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RunData, SseParser, type PointsMessage } from '@simmer/sdk';
import { EVIDENCE_DIR, WEB_URL } from '../lib/env.ts';
import { closeOwner, newTenant, owner } from '../lib/helpers.ts';

const POINTS = Number(process.env.POINTS ?? 864_000);
const lines: string[] = [];
const say = (line = '') => {
  lines.push(line);
  console.log(line);
};

async function main() {
  const t = await newTenant('long-run');
  const run = await t.client.createRun('one-day-at-10-per-second');
  // Written straight into the tables: 5 metrics, batches of 10 points.
  await owner().query(
    `insert into points (run_id, project_id, key, step, value, seq)
     select $1, $2, 'metric/' || (g % 5), g / 5, sin(g * 0.001) + g * 0.00001, g / 10 + 1
     from generate_series(0, $3 - 1) g`,
    [run.id, t.projectId, POINTS],
  );
  await owner().query('update runs set last_seq = $2, point_count = $3 where id = $1', [run.id, POINTS / 10, POINTS]);

  say(`# Opening a run with ${POINTS.toLocaleString('en-US')} points (10 points/s for ${(POINTS / 36000).toFixed(0)} hours)`);
  const before = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const response = await fetch(`${WEB_URL}/api/runs/${run.id}/events`, {
    headers: { authorization: `Bearer ${t.secret}` },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const data = new RunData();
  let bytes = 0;
  let messages = 0;
  let firstPointsAt = 0;
  while (data.count < POINTS) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
      if (event.event !== 'points') continue;
      if (!firstPointsAt) firstPointsAt = performance.now();
      const result = data.apply(JSON.parse(event.data) as PointsMessage);
      if (result.kind !== 'applied') throw new Error(`unexpected ${result.kind}`);
      messages++;
    }
  }
  const took = performance.now() - startedAt;
  await reader.cancel();
  globalThis.gc?.();
  say(`first points after   ${(firstPointsAt - startedAt).toFixed(0)} ms`);
  say(`complete after       ${(took / 1000).toFixed(1)} s`);
  say(`transferred          ${(bytes / 1e6).toFixed(1)} MB in ${messages} messages (uncompressed)`);
  say(`points applied       ${data.count.toLocaleString('en-US')}`);
  say(`reader heap growth   about ${((process.memoryUsage().heapUsed - before) / 1e6).toFixed(0)} MB (Node, not a browser)`);
  say();
  say('That is the cost of reading every point. The page now starts from the overview instead:');
  say();
  const overviewStartedAt = performance.now();
  const overviewResponse = await fetch(`${WEB_URL}/api/runs/${run.id}/overview`, {
    headers: { authorization: `Bearer ${t.secret}` },
  });
  const overviewText = await overviewResponse.text();
  const overview = JSON.parse(overviewText);
  const seeded = new RunData();
  seeded.seed(overview);
  say(`overview answered    ${((performance.now() - overviewStartedAt) / 1000).toFixed(1)} s`);
  say(`transferred          ${(overviewText.length / 1e6).toFixed(2)} MB (uncompressed)`);
  say(`points to draw       ${seeded.held.toLocaleString('en-US')} of ${seeded.count.toLocaleString('en-US')}`);
  say(`continues from       cursor ${seeded.cursor} on the stream`);

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, 'long-run.txt'), lines.join('\n') + '\n');
  }
  await closeOwner();
}

void main();
