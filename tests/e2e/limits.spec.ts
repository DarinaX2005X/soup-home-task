import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { WEB_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, series, type Tenant } from '../lib/helpers.ts';

test.afterAll(closeOwner);

// The site is served over HTTP/1.1, where a browser opens at most six
// connections to one origin, and every live run page holds one for its stream.

/** sessionStorage belongs to one tab. This hands every new tab the key, the way "duplicate tab" would. */
const shareKey = (context: BrowserContext, t: Tenant) =>
  context.addInitScript((key) => sessionStorage.setItem('simmer.key', key), t.secret);

async function openRunPages(context: BrowserContext, runId: string, count: number): Promise<Page[]> {
  const pages = [];
  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    void page.goto(`${WEB_URL}/runs/${runId}`, { waitUntil: 'commit' }).catch(() => {});
    pages.push(page);
  }
  return pages;
}

const goesLive = (page: Page, timeout = 6000) =>
  expect(page.getByTestId('sync'))
    .toHaveAttribute('data-state', 'live', { timeout })
    .then(() => true, () => false);

/** Headless pages always report "visible". This tells the page what a real tab switch would. */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test('background tabs give their connection back, so more than six run pages can be open', async ({ context }) => {
  const t = await newTenant('tabs');
  const run = await t.client.createRun('tabs-run');
  await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 10)));

  await shareKey(context, t);
  const pages = await openRunPages(context, run.id, 6);
  for (const page of pages) expect(await goesLive(page)).toBe(true);

  // The person moves on to other tabs. After five seconds in the background a
  // page lets go of its stream.
  for (const page of pages) await setHidden(page, true);
  await pages[0]!.waitForTimeout(6000);

  const more = await openRunPages(context, run.id, 2);
  const live = [];
  for (const page of more) live.push(await goesLive(page));
  console.log(`seventh and eighth run page went live: ${live.join(', ')}`);
  expect(live).toEqual([true, true]);

  // Data arrives while the first page is in the background. Coming back to
  // it, it catches up from where it stopped.
  await t.client.sendMetrics(run.id, batchOf(series('loss', 10, 25)));
  for (const page of more) await setHidden(page, true);
  await more[0]!.waitForTimeout(6000);
  await setHidden(pages[0]!, false);
  await expect(pages[0]!.getByTestId('sync')).toHaveAttribute('data-count', '25');
  await expect(pages[0]!.getByTestId('sync')).toHaveAttribute('data-state', 'live');
  await expect(pages[0]!.getByTestId('sync')).toHaveAttribute('data-resyncs', '0');
});

// What is still true, kept as a test so it stays visible: with more than six
// run pages actually on screen at once (several windows), the seventh waits
// without an error. test.fail() means this is expected to fail today and will
// be reported as soon as it starts passing, for example once the site is
// served over HTTP/2.
test('eight run pages visible at the same time all go live', async ({ context }) => {
  test.fail(true, 'HTTP/1.1 allows six connections per origin, and each visible live page holds one');
  const t = await newTenant('windows');
  const run = await t.client.createRun('windows-run');
  await t.client.sendMetrics(run.id, batchOf(series('loss', 0, 10)));
  await shareKey(context, t);
  const pages = await openRunPages(context, run.id, 8);
  const live: boolean[] = [];
  for (const page of pages) live.push(await goesLive(page));
  console.log(`run pages that went live, in opening order: ${live.map((ok) => (ok ? 'yes' : 'NO')).join(' ')}`);
  expect(live.filter(Boolean).length).toBe(8);
});
