import { expect, test, type Page } from '@playwright/test';
import { WEB_URL } from '../lib/env.ts';
import { batchOf, closeOwner, newTenant, series, type Tenant } from '../lib/helpers.ts';

test.afterAll(closeOwner);

async function signIn(page: Page, tenant: Tenant) {
  await page.goto(WEB_URL);
  await page.getByLabel('API key').fill(tenant.secret);
  await page.getByRole('button', { name: 'Open project' }).click();
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
}

test('after switching keys in one tab, nothing of the previous project is left on screen or reachable', async ({ page }) => {
  const a = await newTenant('ui-a');
  const b = await newTenant('ui-b');
  const runA = await a.client.createRun('alpha-confidential-run');
  await a.client.sendMetrics(runA.id, batchOf(series('alpha/secret-metric', 0, 50)));
  const runB = await b.client.createRun('beta-run');
  await b.client.sendMetrics(runB.id, batchOf(series('beta/metric', 0, 5)));

  await signIn(page, a);
  await page.locator(`[data-run="${runA.id}"]`).click();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-count', '50');
  await expect(page.locator('body')).toContainText('alpha/secret-metric');

  await page.getByTestId('sign-out').click();
  await expect(page.getByLabel('API key')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('alpha');
  // The key is gone from the tab's storage too.
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain('sk_');

  await page.getByLabel('API key').fill(b.secret);
  await page.getByRole('button', { name: 'Open project' }).click();
  await expect(page.locator(`[data-run="${runB.id}"]`)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('alpha');
  await expect(page.locator(`[data-run="${runA.id}"]`)).toHaveCount(0);

  // B opens A's exact address, the way a pasted link or the back button would.
  const requests: number[] = [];
  page.on('response', (response) => {
    if (response.url().includes(runA.id)) requests.push(response.status());
  });
  await page.goto(`${WEB_URL}/runs/${runA.id}`);
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('alpha');
  await expect(page.getByTestId('chart')).toHaveCount(0);
  // The document itself is the app shell (200). Every data request for the id is a 404.
  expect(requests.filter((s) => s !== 200).every((s) => s === 404)).toBe(true);
  expect(requests.filter((s) => s === 404).length).toBeGreaterThanOrEqual(2);

  await page.goBack();
  await expect(page.locator('body')).not.toContainText('alpha');
});

test('rotating a key signs out an open live page and clears what it was showing', async ({ page }) => {
  const t = await newTenant('ui-rotate');
  const run = await t.client.createRun('rotation-run');
  await t.client.sendMetrics(run.id, batchOf(series('rotation/metric', 0, 20)));

  await signIn(page, t);
  await page.locator(`[data-run="${run.id}"]`).click();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-state', 'live');
  await expect(page.locator('body')).toContainText('rotation/metric');

  // Rotated elsewhere, for example by a teammate.
  const rotatedAt = Date.now();
  await t.client.rotateKey(t.keyId);
  await expect(page.getByText('The key this tab was using no longer works')).toBeVisible({ timeout: 5000 });
  console.log(`open page signed out ${Date.now() - rotatedAt} ms after the rotation`);
  await expect(page.locator('body')).not.toContainText('rotation/metric');
  await expect(page.locator('body')).not.toContainText('rotation-run');
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('rotating the key a tab is signed in with keeps the tab working and shows the new key once', async ({ page }) => {
  const t = await newTenant('ui-self-rotate');
  await signIn(page, t);
  await page.getByRole('link', { name: 'API keys' }).click();
  await page.getByTestId('rotate').click();
  await page.getByTestId('confirm').click();
  const secret = await page.getByTestId('new-secret').innerText();
  expect(secret).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
  expect(secret).not.toBe(t.secret);
  // The tab now runs on the new key: the list loads, and the old key is dead.
  await expect(page.getByTestId('keys').locator('.key')).toHaveCount(1);
  const old = await fetch(`${WEB_URL}/api/runs`, { headers: { authorization: `Bearer ${t.secret}` } });
  expect(old.status).toBe(401);
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByTestId('empty')).toBeVisible();
});
