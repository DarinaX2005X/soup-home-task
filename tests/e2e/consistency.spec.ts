import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Client, sendBatch } from '@simmer/sdk';
import { formatValue } from '../../web/src/format.ts';
import { ChaosProxy } from '../lib/chaos.ts';
import { API_URL, EVIDENCE_DIR, WEB_URL } from '../lib/env.ts';
import { closeOwner, invariantViolations, newTenant, owner, rng, rowsText, sleep, storedPoints, type Row } from '../lib/helpers.ts';
import { buildScenario, type Delivery } from '../lib/scenario.ts';

const SEED = Number(process.env.SEED ?? 20261110);

test.afterAll(closeOwner);

async function syncState(page: Page) {
  const chip = page.getByTestId('sync');
  const [state, cursor, count, connects, resyncs, gaps] = await Promise.all(
    ['data-state', 'data-cursor', 'data-count', 'data-connects', 'data-resyncs', 'data-gaps'].map((a) => chip.getAttribute(a)),
  );
  return { state, cursor: Number(cursor), count: Number(count), connects: Number(connects), resyncs: Number(resyncs), gaps: Number(gaps) };
}

async function exportedCsv(page: Page): Promise<string[]> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const lines = readFileSync(await download.path(), 'utf8').trimEnd().split('\n');
  expect(lines[0]).toBe('key,step,value');
  return lines.slice(1);
}

/** Reads the line of one chart back out of the SVG and undoes the scales. */
async function chartPoints(page: Page, metric: string): Promise<{ decimated: boolean; points: [number, number][]; tolerance: number }> {
  const svg = page.locator(`[data-testid="chart"][data-metric="${metric}"]`);
  const attr = async (name: string) => Number(await svg.getAttribute(`data-${name}`));
  const [x0, x1, y0, y1, left, right, top, bottom] = await Promise.all(
    ['x0', 'x1', 'y0', 'y1', 'left', 'right', 'top', 'bottom'].map(attr),
  );
  const d = (await svg.getByTestId('chart-line').getAttribute('d')) ?? '';
  const points = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(([, px, py]): [number, number] => [
    Math.round(x0! + ((Number(px) - left!) / (right! - left!)) * (x1! - x0!)),
    y0! + ((bottom! - Number(py)) / (bottom! - top!)) * (y1! - y0!),
  ]);
  // Coordinates are rounded to a hundredth of a pixel when drawn.
  const tolerance = ((y1! - y0!) / (bottom! - top!)) * 0.011;
  return { decimated: (await svg.getAttribute('data-decimated')) === 'yes', points, tolerance };
}

test('what the page shows equals what is stored, after disorder, duplicates, late data and lost connections', async ({ page }, testInfo) => {
  const random = rng(SEED);
  const scenario = buildScenario(random);
  const report: string[] = [];
  const say = (line: string) => {
    report.push(line);
    console.log(line);
  };
  say(`seed ${SEED}`);
  say(`scenario: ${JSON.stringify(scenario.counts)}`);

  // Two bad networks: one between the browser and the site, one between the
  // training client and the API. They fail independently.
  const browserNet = new ChaosProxy(WEB_URL, random);
  const clientNet = new ChaosProxy(API_URL, random);
  clientNet.faults = {
    match: (method, url) => method === 'POST' && url.endsWith('/metrics'),
    dropRequest: 0.12,
    dropResponse: 0.12,
    maxDelayMs: 180,
  };
  const siteUrl = await browserNet.listen();
  const ingestUrl = await clientNet.listen();

  const tenant = await newTenant('e2e');
  const run = await tenant.client.createRun('consistency-run');
  const flaky = new Client({ baseUrl: ingestUrl, apiKey: tenant.secret });

  // Sign in through the form and open the run from the list, like a person.
  await page.goto(siteUrl);
  await page.getByLabel('API key').fill(tenant.secret);
  await page.getByRole('button', { name: 'Open project' }).click();
  await page.locator(`[data-testid="run-row"][data-run="${run.id}"]`).click();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('no-points')).toBeVisible();
  await page.evaluate(() => ((window as any).__neverReloaded = true));

  // While traffic flows, keep checking that the page never shows more than is
  // stored and never goes backwards.
  const samples = { taken: 0, maxBehind: 0, sawOffline: false, sawCatchingUp: false };
  let sampling = true;
  let last = { cursor: 0, count: 0 };
  const sampler = (async () => {
    while (sampling) {
      const shown = await syncState(page).catch(() => null);
      if (shown) {
        const stored = (await owner().query('select last_seq, point_count from runs where id = $1', [run.id])).rows[0];
        expect(shown.cursor, 'page is ahead of the database').toBeLessThanOrEqual(Number(stored.last_seq));
        expect(shown.count, 'page shows more points than are stored').toBeLessThanOrEqual(Number(stored.point_count));
        expect(shown.cursor, 'cursor went backwards').toBeGreaterThanOrEqual(last.cursor);
        expect(shown.count, 'points disappeared from the page').toBeGreaterThanOrEqual(last.count);
        last = shown;
        samples.taken++;
        samples.maxBehind = Math.max(samples.maxBehind, Number(stored.last_seq) - shown.cursor);
        samples.sawOffline ||= shown.state === 'offline';
        samples.sawCatchingUp ||= shown.state === 'catching_up';
      }
      await sleep(120);
    }
  })();

  const sent = { attempts: 0, retries: 0, replayed: 0, accepted: 0, duplicates: 0, conflicts: 0 };
  const deliver = async (delivery: Delivery) => {
    const { result, attempts } = await sendBatch(flaky, run.id, delivery.batch, {
      timeoutMs: 2000,
      maxAttempts: 30,
      minDelayMs: 20,
      maxDelayMs: 300,
    });
    sent.attempts += attempts;
    sent.retries += attempts - 1;
    if (result.replayed) sent.replayed++;
    else {
      sent.accepted += result.accepted;
      sent.duplicates += result.duplicates;
      sent.conflicts += result.conflicts.length;
    }
  };

  // Main phase: four senders at once, so batches really do overtake each other.
  const queue = [...scenario.main];
  const total = queue.length;
  const done = () => total - queue.length;
  const senders = Array.from({ length: 4 }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      await deliver(d);
      await sleep(Math.floor(random() * 30));
    }
  });

  const until = async (fraction: number) => {
    while (done() < total * fraction) await sleep(20);
  };

  await until(0.2);
  say(`at 20%: cut ${browserNet.cutStreams()} open stream(s) between events`);

  await until(0.45);
  browserNet.goDown();
  say('at 45%: browser network down for 3 s while ingestion continues');
  await expect(page.getByTestId('sync')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByText('The connection to the server is lost')).toBeVisible();
  if (EVIDENCE_DIR) await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-offline.png') });
  await sleep(3000);
  browserNet.comeBack();

  await until(0.75);
  await expect(page.getByTestId('sync')).not.toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
  browserNet.cutNextStreamChunkInHalf();
  say('at 75%: next stream chunk cut in half');

  await Promise.all(senders);

  // Late phase: the held-back batches land while the page is offline again.
  browserNet.goDown();
  say(`late phase: ${scenario.late.length} held-back deliveries sent while the browser is offline`);
  const lateQueue = [...scenario.late];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let d = lateQueue.shift(); d; d = lateQueue.shift()) await deliver(d);
    }),
  );
  for (const conflict of scenario.conflicts) await deliver(conflict);
  await sleep(500);
  browserNet.comeBack();

  // Quiescence: the page says it is in step and its count equals the table's.
  const storedCount = Number((await owner().query('select point_count from runs where id = $1', [run.id])).rows[0].point_count);
  await expect(page.getByTestId('sync')).toHaveAttribute('data-state', 'live', { timeout: 30_000 });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-count', String(storedCount), { timeout: 30_000 });
  sampling = false;
  await sampler;

  // 1. The database holds exactly the generated truth (first value wins).
  const stored = await storedPoints(run.id);
  const expected: Row[] = [...scenario.truth].map(([id, value]) => {
    const [key, step] = id.split(' ');
    return [key!, Number(step), value];
  });
  expected.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  expect(rowsText(stored)).toEqual(rowsText(expected));
  // Each contradicting batch was recorded once, however many times it was retried.
  const conflictCount = (await owner().query('select conflict_count from runs where id = $1', [run.id])).rows[0].conflict_count;
  expect(Number(conflictCount)).toBe(scenario.counts.conflicts);
  expect(await invariantViolations([run.id])).toEqual([]);

  // 2. The API returns exactly the table.
  const viaApi: Row[] = [];
  for (let after = 0; ; ) {
    const pageOfPoints = await tenant.client.getMetrics(run.id, after, 1000);
    for (const [key, step, value] of pageOfPoints.points) viaApi.push([key, step, typeof value === 'number' ? value : Number(value)]);
    after = pageOfPoints.to;
    if (!pageOfPoints.has_more) break;
  }
  viaApi.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  expect(rowsText(viaApi)).toEqual(rowsText(stored));

  // 3. The page. First, that it is still the same page that lived through it all.
  expect(await page.evaluate(() => (window as any).__neverReloaded)).toBe(true);
  const final = await syncState(page);
  expect(final.resyncs, 'the page had to throw its copy away').toBe(0);
  expect(final.gaps).toBe(0);
  expect(final.connects).toBeGreaterThanOrEqual(4);

  // 3a. Every point the page holds, through its CSV export, against the table.
  const storedCsv = stored.map(([key, step, value]) => `${key},${step},${value}`);
  expect(await exportedCsv(page)).toEqual(storedCsv);

  // 3b. The numbers a person reads in the summary table.
  const metrics = [...new Set(stored.map((r) => r[0]))];
  for (const metric of metrics) {
    const rows = stored.filter((r) => r[0] === metric);
    const finite = rows.map((r) => r[2]).filter(Number.isFinite);
    const row = page.locator(`[data-testid="summary"] tr[data-metric="${metric}"]`);
    await expect(row.locator('[data-col="count"]')).toHaveText(String(rows.length));
    await expect(row.locator('[data-col="last-step"]')).toHaveText(String(rows.at(-1)![1]));
    await expect(row.locator('[data-col="last-value"]')).toHaveText(formatValue(rows.at(-1)![2]));
    await expect(row.locator('[data-col="min"]')).toHaveText(formatValue(Math.min(...finite)));
    await expect(row.locator('[data-col="max"]')).toContainText(formatValue(Math.max(...finite)));
  }
  await expect(page.getByTestId('total-points')).toHaveText(`${stored.length.toLocaleString('en-US')} points`);

  // 3c. The drawn lines: every finite stored point is a vertex, in step order.
  let vertices = 0;
  for (const metric of metrics) {
    const drawn = await chartPoints(page, metric);
    expect(drawn.decimated).toBe(false);
    const finite = stored.filter((r) => r[0] === metric && Number.isFinite(r[2]));
    expect(drawn.points.map((p) => p[0]), `${metric}: steps on the line`).toEqual(finite.map((r) => r[1]));
    drawn.points.forEach(([, value], i) => {
      expect(Math.abs(value - finite[i]![2]), `${metric} step ${finite[i]![1]}`).toBeLessThanOrEqual(drawn.tolerance);
    });
    vertices += drawn.points.length;
  }

  // 4. A fresh load reaches the same state by the cold path.
  if (EVIDENCE_DIR) await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-final.png'), fullPage: true });
  await page.reload();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-count', String(storedCount), { timeout: 30_000 });
  expect(await exportedCsv(page)).toEqual(storedCsv);

  say(`ingest client: ${JSON.stringify(sent)}`);
  say(`client network: ${JSON.stringify(clientNet.stats)}`);
  say(`browser network: ${JSON.stringify(browserNet.stats)}`);
  say(`page: ${JSON.stringify(final)}`);
  say(`samples while running: ${samples.taken}, furthest behind ${samples.maxBehind} batches, saw offline=${samples.sawOffline}, saw catching up=${samples.sawCatchingUp}`);
  say(`stored: ${stored.length} points in ${metrics.length} metrics; CSV rows compared: ${storedCsv.length}; chart vertices compared: ${vertices}`);
  say('RESULT: database = expected truth = API = page CSV = page summary = chart geometry; fresh reload = same');

  expect(samples.sawOffline).toBe(true);
  expect(clientNet.stats.droppedResponses).toBeGreaterThan(0);
  expect(sent.replayed).toBeGreaterThan(0);

  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, `e2e-consistency-seed-${SEED}.txt`), report.join('\n') + '\n');
  }
  await testInfo.attach('report', { body: report.join('\n'), contentType: 'text/plain' });
  await browserNet.close();
  await clientNet.close();
});
