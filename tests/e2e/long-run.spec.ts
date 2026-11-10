import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { formatValue } from '../../web/src/format.ts';
import path from 'node:path';
import { EVIDENCE_DIR, WEB_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, owner, series, storedPoints } from '../lib/helpers.ts';

test.afterAll(closeOwner);

const POINTS = 200_000;

test('a long run opens from a thinned history, stays exact in its figures, and exports every point', async ({ page }) => {
  const t = await newTenant('e2e-long');
  const run = await t.client.createRun('long-run');
  await owner().query(
    `insert into points (run_id, project_id, key, step, value, seq)
     select $1, $2, 'metric/' || (g % 4), g / 4, sin(g * 0.0002) * (1 + g % 4) + (g % 13) * 0.001, g / 10 + 1
     from generate_series(0, $3 - 1) g`,
    [run.id, t.projectId, POINTS],
  );
  await owner().query('update runs set last_seq = $2, point_count = $3 where id = $1', [run.id, POINTS / 10, POINTS]);

  let streamed = 0;
  let overviewBytes = 0;
  page.on('response', async (response) => {
    if (response.url().endsWith('/overview')) overviewBytes = (await response.body()).length;
  });
  page.on('requestfinished', async (request) => {
    if (request.url().endsWith('/events')) streamed += (await request.sizes()).responseBodySize;
  });

  await page.goto(WEB_URL);
  await page.getByLabel('API key').fill(t.secret);
  await page.getByRole('button', { name: 'Open project' }).click();
  const openedAt = Date.now();
  await page.locator(`[data-run="${run.id}"]`).click();
  const sync = page.getByTestId('sync');
  await expect(sync).toHaveAttribute('data-state', 'live');
  await expect(sync).toHaveAttribute('data-count', String(POINTS));
  console.log(`page of a ${POINTS} point run was live ${Date.now() - openedAt} ms after the click; overview ${(overviewBytes / 1e3).toFixed(0)} KB`);
  await expect(sync).toHaveAttribute('data-thinned', 'yes');
  await expect(page.getByTestId('thinned')).toBeVisible();
  expect(overviewBytes).toBeLessThan(500_000);

  // New points arrive after the page opened, one of them out of order.
  await t.client.sendMetrics(run.id, batchOf([...series('metric/0', 50_000, 50_020), { key: 'metric/new', step: 3, value: 0.25 }]));
  await expect(sync).toHaveAttribute('data-count', String(POINTS + 21));
  await expect(sync).toHaveAttribute('data-state', 'live');
  await expect(sync).toHaveAttribute('data-resyncs', '0');

  // The figures a person reads are exact, though the page holds a fraction of the points.
  const stored = await storedPoints(run.id);
  expect(stored).toHaveLength(POINTS + 21);
  for (const metric of [...new Set(stored.map((r) => r[0]))]) {
    const rows = stored.filter((r) => r[0] === metric);
    const values = rows.map((r) => r[2]);
    const row = page.locator(`[data-testid="summary"] tr[data-metric="${metric}"]`);
    await expect(row.locator('[data-col="count"]')).toHaveText(String(rows.length));
    await expect(row.locator('[data-col="last-step"]')).toHaveText(String(rows.at(-1)![1]));
    await expect(row.locator('[data-col="last-value"]')).toHaveText(formatValue(rows.at(-1)![2]));
    await expect(row.locator('[data-col="min"]')).toHaveText(formatValue(values.reduce((a, b) => Math.min(a, b))));
    await expect(row.locator('[data-col="max"]')).toHaveText(formatValue(values.reduce((a, b) => Math.max(a, b))));
  }

  if (EVIDENCE_DIR) await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-long-run.png') });

  // The export is every stored point, not the thinned view.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const lines = readFileSync(await download.path(), 'utf8').trimEnd().split('\n');
  expect(lines.length - 1).toBe(POINTS + 21);
  expect(lines.slice(1)).toEqual(stored.map(([key, step, value]) => `${key},${step},${value}`));
  console.log(`exported ${lines.length - 1} rows, equal to the table`);
});
