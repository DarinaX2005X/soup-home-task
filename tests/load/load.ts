// Load test: RUNS concurrent runs, each producing RATE points per second, with
// VIEWERS live pages on every run. Open loop: batches are sent on a clock
// whether or not earlier ones were answered, so a slow server shows up as
// latency instead of quietly lowering the load.
//
// The load is produced by WORKERS separate processes. One process was not
// enough: at 500 requests per second it was itself at 100% of a core, and the
// first measurements were of the generator, not of the system.
//
//   npx tsx load/load.ts            (defaults: 50 runs, 10 points/s, 60 s)
//   RUNS=200 BATCH_MS=100 npx tsx load/load.ts

import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, SseParser, makeBatch, type Point, type PointsMessage } from '@simmer/sdk';
import { API_URL, EVIDENCE_DIR, WEB_URL } from '../lib/env.ts';
import { closeOwner, invariantViolations, newTenant, owner, sleep } from '../lib/helpers.ts';

const RUNS = Number(process.env.RUNS ?? 50);
const RATE = Number(process.env.RATE ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
/** How often each run flushes. 1000 means one batch of RATE points per second, 100 means one point per request. */
const BATCH_MS = Number(process.env.BATCH_MS ?? 1000);
const VIEWERS = Number(process.env.VIEWERS ?? 2);
const PROJECTS = Number(process.env.PROJECTS ?? 5);
const WORKERS = Number(process.env.WORKERS ?? 6);
/** Viewers go through nginx, as a browser would. */
const VIEW_BASE = process.env.VIEW_BASE ?? `${WEB_URL}/api`;
/** Several API instances can be given, separated by commas. Runs are dealt out between them. */
const INGEST_URLS = (process.env.INGEST_URLS ?? API_URL).split(',');
const VIEW_URLS = (process.env.VIEW_URLS ?? VIEW_BASE).split(',');
const LABEL = process.env.LABEL ?? `${RUNS}x${RATE}-batch${BATCH_MS}ms`;
const PER_BATCH = Math.max(1, Math.round((RATE * BATCH_MS) / 1000));
const TICKS = Math.round((DURATION_S * 1000) / BATCH_MS);

interface Assignment {
  startAt: number;
  runs: { id: string; secret: string; offsetMs: number; ingestUrl: string; viewUrl: string }[];
}

interface WorkerReport {
  latencies: number[];
  lags: number[];
  failures: Record<string, number>;
  maxInFlight: number;
  /** Highest lateness of the worker's own send clock: if this is large, the generator is the bottleneck. */
  maxClockSlipMs: number;
  runs: { id: string; acknowledged: number }[];
  viewers: { runId: string; received: number; broken: string | null }[];
}

// Worker: drives its share of the runs and their viewers

async function worker(assignment: Assignment): Promise<WorkerReport> {
  const report: WorkerReport = { latencies: [], lags: [], failures: {}, maxInFlight: 0, maxClockSlipMs: 0, runs: [], viewers: [] };
  const controller = new AbortController();
  const runs = assignment.runs.map((r) => ({
    ...r,
    client: new Client({ baseUrl: r.ingestUrl, apiKey: r.secret }),
    step: 0,
    acknowledged: 0,
  }));

  // A live page reduced to what matters here: it counts points and times their arrival.
  const viewers = runs.flatMap((run) =>
    Array.from({ length: VIEWERS }, () => {
      const viewer = { runId: run.id, received: 0, cursor: 0, broken: null as string | null };
      void (async () => {
        try {
          const response = await fetch(`${run.viewUrl}/runs/${run.id}/events`, {
            headers: { authorization: `Bearer ${run.secret}` },
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
              // Each point carries the time it was due to be sent as its value.
              for (const point of message.points) report.lags.push(now - (point[2] as number));
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) viewer.broken = (error as Error).message;
        }
      })();
      return viewer;
    }),
  );

  let inFlight = 0;
  const pending: Promise<void>[] = [];
  const fire = (run: (typeof runs)[number], dueAt: number) => {
    report.maxClockSlipMs = Math.max(report.maxClockSlipMs, Date.now() - dueAt);
    const points: Point[] = [];
    for (let i = 0; i < PER_BATCH; i++) points.push({ key: `m${i % 5}`, step: run.step + Math.floor(i / 5), value: dueAt });
    run.step += Math.ceil(PER_BATCH / 5);
    inFlight++;
    report.maxInFlight = Math.max(report.maxInFlight, inFlight);
    pending.push(
      run.client.sendMetrics(run.id, makeBatch(points)).then(
        (result) => {
          report.latencies.push(Date.now() - dueAt);
          run.acknowledged += result.accepted;
          inFlight--;
        },
        (error) => {
          const reason = String(error?.code ?? error?.name ?? 'error');
          report.failures[reason] = (report.failures[reason] ?? 0) + 1;
          inFlight--;
        },
      ),
    );
  };

  await sleep(assignment.startAt - Date.now());
  for (let tick = 0; tick < TICKS; tick++) {
    const due = assignment.startAt + tick * BATCH_MS;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    // Each run has its own phase within the interval, so sends are spread out.
    for (const run of runs) setTimeout(() => fire(run, due + run.offsetMs), run.offsetMs);
  }
  await sleep(BATCH_MS + 100);
  await Promise.all(pending);

  // Give viewers up to 20 s to receive the tail.
  const expected = new Map(runs.map((r) => [r.id, r.acknowledged]));
  const deadline = Date.now() + 20_000;
  while (viewers.some((v) => v.received < expected.get(v.runId)!) && Date.now() < deadline) await sleep(50);
  controller.abort();

  report.runs = runs.map((r) => ({ id: r.id, acknowledged: r.acknowledged }));
  report.viewers = viewers.map((v) => ({ runId: v.runId, received: v.received, broken: v.broken }));
  return report;
}

// Parent: sets up, starts workers, watches the API, checks the result

const lines: string[] = [];
const say = (line = '') => {
  lines.push(line);
  console.log(line);
};

function percentiles(values: number[]) {
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] ?? NaN };
}
const ms = (p: ReturnType<typeof percentiles>) =>
  `p50 ${p.p50.toFixed(0)} ms, p95 ${p.p95.toFixed(0)} ms, p99 ${p.p99.toFixed(0)} ms, max ${p.max.toFixed(0)} ms (n=${p.n})`;

async function parent() {
  say(`# Load: ${RUNS} runs x ${RATE} points/s for ${DURATION_S} s`);
  say(`batch every ${BATCH_MS} ms (${PER_BATCH} point${PER_BATCH === 1 ? '' : 's'} per request, ${(RUNS * 1000) / BATCH_MS} requests/s in total)`);
  say(`${VIEWERS} live viewers per run through ${VIEW_URLS.join(' and ')}, ${PROJECTS} projects, ingest to ${INGEST_URLS.join(' and ')}`);
  say(`${WORKERS} generator processes, started ${new Date().toISOString()}`);

  const tenants = await Promise.all(Array.from({ length: PROJECTS }, (_, i) => newTenant(`load-${i}`)));
  const runs = await Promise.all(
    Array.from({ length: RUNS }, async (_, i) => {
      const tenant = tenants[i % PROJECTS]!;
      return {
        id: (await tenant.client.createRun(`load-${i}`)).id,
        secret: tenant.secret,
        offsetMs: Math.floor((i / RUNS) * BATCH_MS),
        ingestUrl: INGEST_URLS[i % INGEST_URLS.length]!,
        // Offset by one, so with two instances a run is written through one and watched through the other.
        viewUrl: VIEW_URLS[(i + 1) % VIEW_URLS.length]!,
      };
    }),
  );

  const startAt = Date.now() + 4000;
  const reports = Array.from({ length: WORKERS }, (_, w) => {
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, LOAD_WORKER: '1' } });
    child.send({ startAt, runs: runs.filter((_, i) => i % WORKERS === w) } satisfies Assignment);
    return new Promise<WorkerReport>((resolve, reject) => {
      child.on('message', (message) => resolve(message as WorkerReport));
      child.on('exit', (code) => code !== 0 && reject(new Error(`generator ${w} exited with ${code}`)));
    });
  });

  const stats: { rss: number; waiting: number; buffered: number }[] = [];
  const statTimer = setInterval(async () => {
    try {
      const s = await (await fetch(`${API_URL}/_test/stats`)).json();
      stats.push({ rss: s.rss, waiting: s.pool.waiting, buffered: s.stream_buffered_bytes });
    } catch {
      // Stats are a side channel. Missing a sample is not a result.
    }
  }, 1000);

  const results = await Promise.all(reports);
  clearInterval(statTimer);
  const took = (Date.now() - startAt) / 1000;

  const latencies = results.flatMap((r) => r.latencies);
  const lags = results.flatMap((r) => r.lags);
  const failures: Record<string, number> = {};
  for (const r of results) for (const [k, n] of Object.entries(r.failures)) failures[k] = (failures[k] ?? 0) + n;
  const failed = Object.values(failures).reduce((a, b) => a + b, 0);
  const acknowledged = new Map(results.flatMap((r) => r.runs.map((run) => [run.id, run.acknowledged] as const)));
  const viewers = results.flatMap((r) => r.viewers);
  const incomplete = viewers.filter((v) => v.received !== acknowledged.get(v.runId));
  const broken = viewers.filter((v) => v.broken);
  const totalAcknowledged = [...acknowledged.values()].reduce((a, b) => a + b, 0);
  const expected = RUNS * PER_BATCH * TICKS;

  const stored = await owner().query('select coalesce(sum(point_count), 0) as n from runs where id = any($1)', [runs.map((r) => r.id)]);
  const violations = await invariantViolations(runs.map((r) => r.id));
  const peak = (pick: (s: (typeof stats)[number]) => number) => (stats.length ? Math.max(...stats.map(pick)) : NaN);

  say();
  say(`requests            ${latencies.length + failed} sent, ${failed} failed${failed ? ' ' + JSON.stringify(failures) : ''}`);
  say(`points              ${expected} planned, ${totalAcknowledged} acknowledged, ${stored.rows[0].n} stored`);
  say(`ingest latency      ${ms(percentiles(latencies))}`);
  say(`                    measured from the moment a batch was due to the answer`);
  say(`delivery lag        ${ms(percentiles(lags))}`);
  say(`                    measured from the moment a batch was due to a viewer holding its points`);
  say(`viewers             ${viewers.length}: ${viewers.length - incomplete.length} complete, ${incomplete.length} incomplete, ${broken.length} broken`);
  if (broken[0]) say(`first broken        ${broken[0].broken}`);
  say(`requests in flight  peak ${Math.max(...results.map((r) => r.maxInFlight))} in one generator`);
  say(`generator clock     at most ${Math.max(...results.map((r) => r.maxClockSlipMs))} ms late (large means the generator, not the system, was the limit)`);
  say(`api process         rss peak ${(peak((s) => s.rss) / 1e6).toFixed(0)} MB, db pool waiters peak ${peak((s) => s.waiting)}, stream buffer peak ${(peak((s) => s.buffered) / 1e3).toFixed(0)} KB`);
  say(`whole run           ${took.toFixed(1)} s for ${DURATION_S} s of traffic`);
  say(`invariants          ${violations.length === 0 ? 'all hold' : violations.length + ' VIOLATED'}`);
  for (const v of violations.slice(0, 10)) say(`  ${v}`);

  const ok =
    failed === 0 &&
    totalAcknowledged === expected &&
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

if (process.env.LOAD_WORKER === '1') {
  process.once('message', (assignment) => {
    void worker(assignment as Assignment).then((report) => {
      process.send!(report, () => process.exit(0));
    });
  });
} else {
  void parent();
}
