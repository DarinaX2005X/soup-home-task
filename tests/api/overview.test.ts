import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RunData, uuidv4, type Overview } from '@simmer/sdk';
import { API_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, openStream, owner, series, sleep, type Tenant } from '../lib/helpers.ts';

// The overview is what a page of a long run starts from instead of reading
// every point. These tests hold it against the table.

let t: Tenant;
let runId: string;
const POINTS = 240_000;

beforeAll(async () => {
  t = await newTenant('overview');
  runId = (await t.client.createRun('long')).id;
  // Three metrics, written straight into the tables. "spiky" has one sample
  // far above the rest, "sparse" has only even steps, "broken" has NaNs.
  await owner().query(
    `insert into points (run_id, project_id, key, step, value, seq)
     select $1, $2,
            (array['spiky', 'sparse', 'broken'])[g % 3 + 1],
            case when g % 3 = 1 then (g / 3) * 2 else g / 3 end,
            case when g = 150000 then 9999
                 when g % 3 = 2 and (g / 3) % 1000 = 7 then 'NaN'::float8
                 else sin(g * 0.0003) * 10 + (g % 17) * 0.01 end,
            g / 10 + 1
     from generate_series(0, $3 - 1) g`,
    [runId, t.projectId, POINTS],
  );
  await owner().query('update runs set last_seq = $2, point_count = $3 where id = $1', [runId, POINTS / 10, POINTS]);
});

afterAll(closeOwner);

describe('the overview of a long run', () => {
  let overview: Overview;

  test('is small, however long the run is', async () => {
    const response = await fetch(`${API_URL}/runs/${runId}/overview`, { headers: { authorization: `Bearer ${t.secret}` } });
    const text = await response.text();
    overview = JSON.parse(text);
    const shown = overview.metrics.reduce((sum, m) => sum + m.points.length, 0);
    console.log(`overview of ${POINTS} points: ${(text.length / 1e3).toFixed(0)} KB, ${shown} points to draw`);
    expect(text.length).toBeLessThan(400_000);
    expect(shown).toBeLessThanOrEqual(3 * overview.buckets * 2);
    expect(overview).toMatchObject({ head: POINTS / 10, points: POINTS });
  });

  test('gives exact figures for every metric', async () => {
    const truth = await owner().query(
      `select key, count(*)::int as count, max(step)::int as last_step,
              min(value) filter (where value <> 'NaN') as lo, max(value) filter (where value <> 'NaN') as hi,
              (count(*) filter (where value = 'NaN'))::int as non_finite
       from points where run_id = $1 group by key order by key`,
      [runId],
    );
    expect(overview.metrics.map(({ key, count, last_step, lo, hi, non_finite }) => ({ key, count, last_step, lo, hi, non_finite }))).toEqual(truth.rows);
    for (const metric of overview.metrics) {
      const last = await owner().query('select value from points where run_id = $1 and key = $2 and step = $3', [runId, metric.key, metric.last_step]);
      expect(metric.last_value).toBe(last.rows[0].value);
    }
  });

  test('draws only points that are stored, in step order, and keeps the extremes of every slice', async () => {
    for (const metric of overview.metrics) {
      const stored = await owner().query('select step, value from points where run_id = $1 and key = $2 order by step', [runId, metric.key]);
      const byStep = new Map<number, number>(stored.rows.map((r) => [Number(r.step), r.value]));
      let previous = -1;
      for (const [step, value] of metric.points) {
        expect(byStep.get(step), `${metric.key} step ${step}`).toBe(value);
        expect(step).toBeGreaterThan(previous);
        previous = step;
      }
      // Cut the step range into the same number of slices and compare extremes.
      const steps = stored.rows.map((r) => Number(r.step));
      const s0 = steps[0]!;
      const span = steps[steps.length - 1]! + 1 - s0;
      const slice = (step: number) => Math.min(overview.buckets - 1, Math.floor(((step - s0) / span) * overview.buckets));
      const truth = new Map<number, { lo: number; hi: number }>();
      for (const r of stored.rows) {
        if (!Number.isFinite(r.value)) continue;
        const k = slice(Number(r.step));
        const e = truth.get(k) ?? { lo: Infinity, hi: -Infinity };
        truth.set(k, { lo: Math.min(e.lo, r.value), hi: Math.max(e.hi, r.value) });
      }
      const shown = new Map<number, number[]>();
      for (const [step, value] of metric.points) shown.set(slice(step), [...(shown.get(slice(step)) ?? []), value]);
      // Slice edges are computed in floating point on both sides, so a point
      // on an edge may sit in the neighbouring slice.
      for (const [k, e] of truth) {
        const near = [k - 1, k, k + 1].flatMap((n) => shown.get(n) ?? []);
        expect(near, `${metric.key} slice ${k} low`).toContain(e.lo);
        expect(near, `${metric.key} slice ${k} high`).toContain(e.hi);
      }
    }
    const spiky = overview.metrics.find((m) => m.key === 'spiky')!;
    expect(spiky.points.some(([, value]) => value === 9999)).toBe(true);
    const broken = overview.metrics.find((m) => m.key === 'broken')!;
    expect(broken.points.every(([, value]) => Number.isFinite(value))).toBe(true);
  });

  test('a view seeded from it and continued on the stream stays equal to the table', async () => {
    const data = new RunData();
    data.seed(overview);
    expect(data.count).toBe(POINTS);
    // New points after the overview: later steps, a late odd step in "sparse", a new metric, a NaN.
    await t.client.sendMetrics(runId, batchOf([...series('spiky', 80_000, 80_010), { key: 'sparse', step: 4001, value: -500 }]));
    await t.client.sendMetrics(runId, batchOf([{ key: 'fresh', step: 0, value: 1 }, { key: 'broken', step: 80_000, value: NaN }]));
    const stream = await openStream(t.secret, runId, { after: data.cursor });
    await stream.waitFor((s) => s.messages.at(-1)?.to === overview.head + 2, 5000, 'the two new batches');
    stream.close();
    for (const message of stream.messages) expect(data.apply(message as any).kind).toBe('applied');
    const run = await t.client.getRun(runId);
    // The count the page compares with the server's.
    expect(data.count).toBe(run.points);
    expect(data.count).toBe(POINTS + 13);
    const truth = await owner().query(
      `select key, count(*)::int as count, max(step)::int as last_step,
              min(value) filter (where value <> 'NaN') as lo, max(value) filter (where value <> 'NaN') as hi,
              (count(*) filter (where value = 'NaN'))::int as non_finite
       from points where run_id = $1 group by key order by key`,
      [runId],
    );
    const mine = [...data.stats!.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, s]) => ({ key, count: s.count, last_step: s.lastStep, lo: s.lo, hi: s.hi, non_finite: s.nonFinite }));
    expect(mine).toEqual(truth.rows);
    // The late point is on the line, between its neighbours.
    const sparse = data.series.get('sparse')!;
    const at = sparse.steps.indexOf(4001);
    expect(sparse.values[at]).toBe(-500);
    expect(sparse.steps[at - 1]!).toBeLessThan(4001);
    expect(sparse.steps[at + 1]!).toBeGreaterThan(4001);
  });

  test('its cursor, count and points come from one moment, even while the run is being written', async () => {
    const run = await t.client.createRun('busy');
    let stop = false;
    const writer = (async () => {
      for (let i = 0; !stop; i++) await t.client.sendMetrics(run.id, batchOf(series('loss', i * 50, i * 50 + 50)));
    })();
    await sleep(100);
    for (let i = 0; i < 25; i++) {
      const o = await t.client.getOverview(run.id);
      // At cursor `head` exactly this many points existed, and this was the last step.
      const then = await owner().query(
        'select count(*)::int as n, max(step)::int as last from points where run_id = $1 and seq <= $2',
        [run.id, o.head],
      );
      expect(o.points).toBe(then.rows[0].n);
      expect(o.metrics[0]?.count ?? 0).toBe(then.rows[0].n);
      if (o.metrics[0]) expect(o.metrics[0].last_step).toBe(then.rows[0].last);
    }
    stop = true;
    await writer;
  });

  test('is refused for another project exactly like a run that does not exist', async () => {
    const other = await newTenant('overview-other');
    const get = (id: string) => fetch(`${API_URL}/runs/${id}/overview`, { headers: { authorization: `Bearer ${other.secret}` } });
    const foreign = await get(runId);
    const missing = await get(uuidv4());
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });
});
