import { expect, test } from '@playwright/test';
import { compIds, fresh, newProject } from './helpers';

test('phone layout: drawers, tap to place, tap pins to wire, tap switches', async ({ page }) => {
  await fresh(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId('toggle-inspector')).toBeInViewport();
  await newProject(page);
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  const place = async (cat: string, type: string, x: number, y: number) => {
    await page.getByTestId('toggle-sidebar').tap();
    const c = page.getByTestId(`cat-${cat}`);
    if ((await c.getAttribute('aria-expanded')) !== 'true') await c.tap();
    await page.getByTestId(`part-${type}`).tap();
    await expect(page.locator('.library')).not.toHaveClass(/\bopen\b/);
    await page.touchscreen.tap(canvas.x + x, canvas.y + y);
  };
  await place('Inputs', 'switch', 90, 200);
  await place('Outputs', 'led', 280, 320);
  const [sw] = await compIds(page, 'switch');
  const [led] = await compIds(page, 'led');
  await page.locator(`[data-pin="${sw}:out"] .pin-hit`).tap();
  await page.locator(`[data-pin="${led}:in"] .pin-hit`).tap();
  await expect(page.locator('.wires .wire')).toHaveCount(1);
  await page.locator(`[data-comp="${sw}"]`).tap();
  await expect(page.locator(`[data-comp="${led}"] .led`)).toHaveClass(/\bon\b/);
  await page.locator(`[data-comp="${led}"]`).tap();
  await page.getByRole('button', { name: 'Edit selection' }).tap();
  await expect(page.locator('.inspector')).toHaveClass(/\bopen\b/);
  await expect(page.locator('.inspector .insp-head h2')).toHaveText('LED');
});
