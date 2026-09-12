import { expect, test as setup } from '@playwright/test';

const username = process.env.NOCOBASE_E2E_USERNAME;
const password = process.env.NOCOBASE_E2E_PASSWORD;

if (!username || !password) {
  throw new Error('NOCOBASE_E2E_USERNAME and NOCOBASE_E2E_PASSWORD must be set for Playwright authentication.');
}

// 保存登录状态，避免每次都要登录
setup('admin', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Username/Email').click();
  await page.getByPlaceholder('Username/Email').fill(username);
  await page.getByPlaceholder('Password').click();
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByTestId('user-center-button')).toBeVisible();

  // 开启配置状态
  await page.evaluate(() => {
    localStorage.setItem('NOCOBASE_DESIGNABLE', 'true');
  });
  await page.context().storageState({
    path: process.env.PLAYWRIGHT_AUTH_FILE,
  });
});
