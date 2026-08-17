import { expect, test } from '@playwright/test';

const PAGE = `<main>
  <h1 data-testid="gyms-page-header-title">Gyms</h1>
  <ul data-testid="gyms-list">
    <li data-testid="gyms-list-item"><h2 data-testid="gym-card-title">Blackwater Valley BJJ</h2></li>
    <li data-testid="gyms-list-item"><h2 data-testid="gym-card-title">Harbour City Jiu-Jitsu</h2></li>
  </ul>
</main>`;

test('passes', async ({ page }) => {
  await page.setContent(PAGE);
  await expect(page.getByTestId('gyms-page-header-title')).toBeVisible();
});

test('fails: the testid was renamed', async ({ page }) => {
  await page.setContent(PAGE);
  await test.step("gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })", async () => {
    await expect(page.getByTestId('gym-card-name')).toBeVisible({ timeout: 1000 });
  });
});

test('fails: strict mode violation', async ({ page }) => {
  await page.setContent(PAGE);
  await expect(page.getByTestId('gyms-list-item')).toBeVisible({ timeout: 1000 });
});
