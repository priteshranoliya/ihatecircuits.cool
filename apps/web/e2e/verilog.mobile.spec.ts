import { expect, test } from '@playwright/test';
import { compIds, fresh } from './helpers';
import { AND2, outBit, setSource } from './verilogHelpers';

test('phone: the Verilog panel docks under the canvas, marks an error, builds and the circuit works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fresh(page);
  await page.getByTestId('open-verilog').tap();
  const panel = page.getByTestId('verilog-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.cm-content')).toBeVisible();

  const vp = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(box.y + 1);
  expect(canvas.height).toBeGreaterThan(120);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await setSource(page, 'module and2(input a, input b, output y);\n  assign y = a &;\nendmodule\n');
  await expect(page.locator('.cm-line', { has: page.locator('.cm-lintRange-error') })).toContainText('assign y');
  await expect(page.getByTestId('verilog-problem').first()).toBeInViewport();

  await setSource(page, AND2);
  await expect(page.getByTestId('verilog-status')).toHaveText('No problems');
  await page.getByTestId('verilog-build').tap();
  await expect(page.getByTestId('crumb-here')).toHaveText('and2');
  const [a, b, y] = await compIds(page, 'pin');
  // The canvas re-frames the new circuit for a moment after a build; tap once it has settled.
  await page.waitForTimeout(600);
  // Tap the left edge of each input box: near the pin on its right edge a touch starts a wire instead.
  await page.waitForTimeout(600);
  for (const id of [a, b]) await page.locator(`[data-comp="${id}"] .pin-box`).tap({ position: { x: 5, y: 12 } });
  await expect(page.locator(outBit(y))).toHaveText('1');

  await page.getByTestId('verilog-close').tap();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});
