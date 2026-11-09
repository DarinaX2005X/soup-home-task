import { expect, test } from '@playwright/test';
import { WEB_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, series } from '../lib/helpers.ts';

test.afterAll(closeOwner);

// A known limit, kept as a test so it stays visible. The site is served over
// HTTP/1.1, where a browser opens at most six connections to one origin. Each
// open run page holds one of them for its stream. With seven run pages open in
// one browser, the seventh cannot connect, and it gets no error either: its
// request simply waits. test.fail() means this test is expected to fail today
// and will be reported as soon as it starts passing.
test('eight run pages open at once in one browser all go live', async ({ context }) => {
  test.fail(true, 'HTTP/1.1 allows six connections per origin, and each live page holds one');
  const t = await newTenant('tabs');
  const run = await t.client.createRun('tabs-run');
  await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 10)));

  const first = await context.newPage();
  await first.goto(WEB_URL);
  await first.getByLabel('API key').fill(t.secret);
  await first.getByRole('button', { name: 'Open project' }).click();
  await expect(first.getByTestId('project-name')).not.toBeEmpty();
  // sessionStorage belongs to one tab. Copy the key the way "duplicate tab" would.
  await context.addInitScript((key) => sessionStorage.setItem('simmer.key', key), t.secret);

  const pages = [];
  for (let i = 0; i < 8; i++) {
    const page = await context.newPage();
    void page.goto(`${WEB_URL}/runs/${run.id}`, { waitUntil: 'commit' }).catch(() => {});
    pages.push(page);
  }
  const live: boolean[] = [];
  for (const page of pages) {
    live.push(
      await expect(page.getByTestId('sync'))
        .toHaveAttribute('data-state', 'live', { timeout: 6000 })
        .then(() => true, () => false),
    );
  }
  console.log(`run pages that went live, in opening order: ${live.map((ok) => (ok ? 'yes' : 'NO')).join(' ')}`);
  expect(live.filter(Boolean).length).toBe(8);
});
