// Load test: RUNS concurrent runs, each producing RATE points per second, with
// VIEWERS live pages on every run. Open loop: batches are sent on a clock
// whether or not earlier ones were answered, so a slow server shows up as
// latency instead of quietly lowering the load.
//
//   npx tsx load/load.ts            (defaults: 50 runs, 10 points/s, 60 s)
//   RUNS=200 BATCH_MS=100 npx tsx load/load.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client, SseParser, makeBatch, type PointsMessage, type Point } from '@simmer/sdk';
import { API_URL, EVIDENCE_DIR, WEB_URL } from '../lib/env.ts';
import { closeOwner, invariantViolations, newTenant, owner, sleep } from '../lib/helpers.ts';

const RUNS = Number(process.env.RUNS ?? 50);
const RATE = Number(process.env.RATE ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
/** How often each run flushes. 1000 means one batch of RATE points per second, 100 means one point per request. */
const BATCH_MS = Number(process.env.BATCH_MS ?? 1000);
const VIEWERS = Number(process.env.VIEWERS ?? 2);
const PROJECTS = Number(process.env.PROJECTS ?? 5);
/** Viewers go through nginx, as a browser would. */
const VIEW_BASE = process.env.VIEW_BASE ?? `${WEB_URL}/api`;
const LABEL = process.env.LABEL ?? `${RUNS}x${RATE}-batch${BATCH_MS}ms`;

const lines: string[] = [];
const say = (line = '') => {
  lines.push(line);
  console.log(line);
};

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] ?? NaN };
}
const ms = (p: ReturnType<typeof percentiles>) =>
  `p50 ${p.p50.toFixed(0)} ms, p95 ${p.p95.toFixed(0)} ms, p99 ${p.p99.toFixed(0)} ms, max ${p.max.toFixed(0)} ms (n=${p.n})`;

interface Viewer {
  received: number;
  cursor: number;
  broken: string | null;
  close: () => void;
}

/** A live page reduced to what matters here: it counts points and times their arrival. */
function view(secret: string, runId: string, lags: number[]): Viewer {
  const controller = new AbortController();
  const viewer: Viewer = { received: 0, cursor: 0, broken: null, close: () => controller.abort() };
  void (async () => {
    try {
      const response = await fetch(`${VIEW_BASE}/runs/${runId}/events`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('stream ended');
        const now = Date.now();
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (event.event !== 'points') continue;
          const message = JSON.parse(event.data) as PointsMessage;
          if (message.from !== viewer.cursor) viewer.broken = `gap: at ${viewer.cursor}, got from ${message.from}`;
          viewer.cursor = message.to;
          viewer.received += message.points.length;
          // Each point carries the time it was sent as its value.
          for (const point of message.points) lags.push(now - (point[2] as number));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) viewer.broken = (error as Error).message;
    }
  })();
  return viewer;
}

async function main() {
  say(`# Load: ${RUNS} runs x ${RATE} points/s for ${DURATION_S} s`);
  say(`batch every ${BATCH_MS} ms (${(RATE * BATCH_MS) / 1000} points per request, ${(RUNS * 1000) / BATCH_MS} requests/s in total)`);
  say(`${VIEWERS} live viewers per run through ${VIEW_BASE}, ${PROJECTS} projects, ingest to ${API_URL}`);
  say(`started ${new Date().toISOString()}`);

  const tenants = await Promise.all(Array.from({ length: PROJECTS }, (_, i) => newTenant(`load-${i}`)));
  const runs = await Promise.all(
    Array.from({ length: RUNS }, async (_, i) => {
      const tenant = tenants[i % PROJECTS]!;
      return { tenant, id: (await tenant.client.createRun(`load-${i}`)).id, sent: 0, step: 0 };
    }),
  );

  const lags: number[] = [];
  const viewers = runs.flatMap((run) => Array.from({ length: VIEWERS }, () => ({ run, viewer: view(run.tenant.secret, run.id, lags) })));
  await sleep(1500);

  const latencies: number[] = [];
  const failures = new Map<string, number>();
  const statSamples: { rss: number; waiting: number; buffered: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pending: Promise<void>[] = [];
  const perBatch = Math.max(1, Math.round((RATE * BATCH_MS) / 1000));

  const fire = (run: (typeof runs)[number], scheduledAt: number) => {
    const points: Point[] = [];
    for (let i = 0; i < perBatch; i++) points.push({ key: `m${i % 5}`, step: run.step + Math.floor(i / 5), value: scheduledAt });
    run.step += Math.ceil(perBatch / 5);
    const batch = makeBatch(points);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    pending.push(
      (run.tenant.client as Client).sendMetrics(run.id, batch).then(
        (result) => {
          latencies.push(Date.now() - scheduledAt);
          run.sent += result.accepted;
          inFlight--;
        },
        (error) => {
          const reason = error?.code ?? error?.name ?? 'error';
          failures.set(reason, (failures.get(reason) ?? 0) + 1);
          inFlight--;
        },
      ),
    );
  };

  const startedAt = Date.now();
  const ticks = Math.round((DURATION_S * 1000) / BATCH_MS);
  const statTimer = setInterval(async () => {
    try {
      const s = await (await fetch(`${API_URL}/_test/stats`)).json();
      statSamples.push({ rss: s.rss, waiting: s.pool.waiting, buffered: s.stream_buffered_bytes });
    } catch {
      // Stats are a side channel. Missing a sample is not a result.
    }
  }, 1000);

  for (let tick = 0; tick < ticks; tick++) {
    const due = startedAt + tick * BATCH_MS;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    // Spread the runs across the interval instead of firing them all at once.
    runs.forEach((run, i) => {
      const offset = (i / runs.length) * BATCH_MS;
      setTimeout(() => fire(run, due + offset), offset);
    });
  }
  await sleep(BATCH_MS + 50);
  await Promise.all(pending);
  const sendingTook = (Date.now() - startedAt) / 1000;
  clearInterval(statTimer);

  // Give viewers up to 15 s to receive the tail, then judge them.
  const totalSent = runs.reduce((sum, run) => sum + run.sent, 0);
  const deadline = Date.now() + 15_000;
  const complete = () => viewers.every(({ run, viewer }) => viewer.received >= run.sent);
  while (!complete() && Date.now() < deadline) await sleep(100);
  const drainTook = (Date.now() - startedAt) / 1000 - sendingTook;

  const incomplete = viewers.filter(({ run, viewer }) => viewer.received !== run.sent);
  const broken = viewers.filter(({ viewer }) => viewer.broken);
  for (const { viewer } of viewers) viewer.close();

  const stored = await owner().query('select coalesce(sum(point_count), 0) as n from runs where id = any($1)', [runs.map((r) => r.id)]);
  const violations = await invariantViolations(runs.map((r) => r.id));
  const failed = [...failures.values()].reduce((a, b) => a + b, 0);
  const expected = RUNS * perBatch * ticks;

  say();
  say(`requests sent      ${latencies.length + failed} in ${sendingTook.toFixed(1)} s (${((latencies.length + failed) / sendingTook).toFixed(0)}/s)`);
  say(`requests failed    ${failed}${failed ? ' ' + JSON.stringify(Object.fromEntries(failures)) : ''}`);
  say(`points planned     ${expected}`);
  say(`points acknowledged ${totalSent}`);
  say(`points stored      ${stored.rows[0].n}`);
  say(`ingest latency     ${ms(percentiles(latencies))}   (from scheduled send time to answer)`);
  say(`max in flight      ${maxInFlight} requests`);
  say(`delivery lag       ${ms(percentiles(lags))}   (from scheduled send time to a viewer holding the point)`);
  say(`viewers            ${viewers.length}, complete ${viewers.length - incomplete.length}, incomplete ${incomplete.length}, broken ${broken.length}`);
  if (broken[0]) say(`first broken       ${broken[0].viewer.broken}`);
  say(`tail drained in    ${drainTook.toFixed(1)} s after the last send`);
  if (statSamples.length > 0) {
    const peak = (pick: (s: (typeof statSamples)[number]) => number) => Math.max(...statSamples.map(pick));
    say(`api process        rss peak ${(peak((s) => s.rss) / 1e6).toFixed(0)} MB, db pool waiters peak ${peak((s) => s.waiting)}, stream buffer peak ${(peak((s) => s.buffered) / 1e3).toFixed(0)} KB`);
  }
  say(`invariants         ${violations.length === 0 ? 'all hold' : violations.length + ' VIOLATED'}`);
  for (const v of violations.slice(0, 10)) say(`  ${v}`);

  const ok =
    failed === 0 &&
    totalSent === expected &&
    Number(stored.rows[0].n) === expected &&
    incomplete.length === 0 &&
    broken.length === 0 &&
    violations.length === 0;
  say();
  say(ok ? 'RESULT: nothing lost, nothing duplicated, every viewer complete' : 'RESULT: FAILED, see the lines above');

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, `load-${LABEL}.txt`), lines.join('\n') + '\n');
  }
  await closeOwner();
  process.exit(ok ? 0 : 1);
}

void main();
