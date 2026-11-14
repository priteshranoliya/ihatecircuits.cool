import { expect, test } from '@playwright/test';
import { compIds, fresh } from './helpers';
import { ADD8, AND2, openVerilog, outBit, setSource } from './verilogHelpers';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await fresh(page);
});
test.afterEach(() => expect(errors, 'browser errors').toEqual([]));

test('a syntax error is marked on the right line, and fixing it clears the marker', async ({ page }) => {
  await openVerilog(page);
  await setSource(page, 'module t(input a, output y);\n  wire w;\n  assign y = a &;\nendmodule\n');
  const marked = page.locator('.cm-line', { has: page.locator('.cm-lintRange-error') });
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText('assign y');
  const problem = page.getByTestId('verilog-problem').first();
  await expect(problem).toHaveAttribute('data-line', '3');
  await expect(problem).toHaveAttribute('data-level', 'error');
  await expect(page.getByTestId('verilog-status')).toContainText('error');
  await problem.click();
  await expect(page.locator('.cm-activeLine')).toContainText('assign y');

  await setSource(page, AND2);
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  await expect(page.getByTestId('verilog-status')).toHaveText('No problems');
});

test('build in blocks view makes a circuit that computes the right outputs', async ({ page }) => {
  await openVerilog(page);
  await setSource(page, AND2);
  await expect(page.getByTestId('verilog-top')).toContainText('Auto (and2)');
  await page.getByTestId('verilog-build').click();
  await expect(page.getByTestId('crumb-here')).toHaveText('and2');
  await expect(page.getByTestId('toast')).toContainText('Built 1 circuit with');
  await expect(page.locator('.parts .part-and')).toHaveCount(1);
  const [a, b, y] = await compIds(page, 'pin');
  await expect(page.locator(outBit(y))).toHaveText('0');
  await page.locator(`[data-comp="${a}"]`).click();
  await expect(page.locator(outBit(y))).toHaveText('0');
  await page.locator(`[data-comp="${b}"]`).click();
  await expect(page.locator(outBit(y))).toHaveText('1');
  await page.locator(`[data-comp="${a}"]`).click();
  await expect(page.locator(outBit(y))).toHaveText('0');
});

test('gates view builds from logic gates and sub-circuits, not word-level parts', async ({ page }) => {
  await openVerilog(page);
  await setSource(page, ADD8);
  await page.getByTestId('verilog-view-blocks').click();
  await page.getByTestId('verilog-build').click();
  await expect(page.getByTestId('crumb-here')).toHaveText('add8');
  await expect(page.locator('.parts .part-adder')).toHaveCount(1);

  await page.getByTestId('verilog-view-gates').click();
  await expect(page.getByTestId('verilog-view-gates')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('verilog-build').click();
  await expect(page.getByTestId('crumb-here')).toHaveText('add8 2');
  await expect(page.locator('.parts .part-adder')).toHaveCount(0);
  await expect(page.locator('.parts .part-sub')).not.toHaveCount(0);
  const [a, b, s] = await compIds(page, 'pin');
  await page.locator(outBit(a, 0).replace(/ \[data.*/, '') + ` [data-pin-bit="0"]`).click();
  await expect(page.locator(outBit(s, 0))).toHaveText('1');
  await page.locator(`[data-comp="${b}"] [data-pin-bit="0"]`).click();
  await expect(page.locator(outBit(s, 1))).toHaveText('1');
  await expect(page.locator(outBit(s, 0))).toHaveText('0');
});

test('one undo removes everything a build added', async ({ page }) => {
  await openVerilog(page);
  await page.getByTestId('verilog-build').click();
  await expect(page.getByTestId('toast')).toContainText('Built 2 circuits');
  await expect(page.getByTestId('crumb-here')).toHaveText('full_adder');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('crumb-here')).not.toHaveText('full_adder');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-new').click();
  await page.keyboard.press('Control+z');
});

test('⌘K opens the editor and builds from it', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('verilog');
  await expect(page.getByTestId('palette-verilog')).toBeVisible();
  await expect(page.getByTestId('palette-verilog-build')).toBeVisible();
  await page.getByTestId('palette-verilog').click();
  await expect(page.getByTestId('verilog-panel')).toBeVisible();
  await expect(page.locator('.cm-content')).toBeFocused();
  await setSource(page, AND2);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('build from verilog');
  await page.getByTestId('palette-verilog-build').click();
  await expect(page.getByTestId('crumb-here')).toHaveText('and2');
});

test('the E key and the header button toggle the panel, and the canvas stays visible', async ({ page }) => {
  await page.keyboard.press('e');
  await expect(page.getByTestId('verilog-panel')).toBeVisible();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  const panel = (await page.getByTestId('verilog-panel').boundingBox())!;
  expect(canvas.width).toBeGreaterThan(300);
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(panel.x + 1);
  await page.getByTestId('verilog-close').click();
  await expect(page.getByTestId('verilog-panel')).toBeHidden();
  await expect(page.getByTestId('open-verilog')).toBeFocused();
  await page.getByTestId('open-verilog').click();
  await expect(page.getByTestId('verilog-panel')).toBeVisible();
});

test('the text is remembered across a reload', async ({ page }) => {
  await openVerilog(page);
  await setSource(page, AND2);
  await expect(page.getByTestId('verilog-status')).toHaveText('No problems');
  expect(await page.evaluate(() => localStorage.getItem('ihatecircuits:verilog:v1'))).toBe(AND2);
  await page.reload();
  await openVerilog(page);
  await expect(page.locator('.cm-content')).toContainText('module and2');
});

test('examples and the circuit loader ask before replacing custom text', async ({ page }) => {
  await openVerilog(page);
  await page.getByTestId('verilog-examples').click();
  await page.getByTestId('verilog-example-counter').click();
  await expect(page.locator('.cm-content')).toContainText('counter4');
  await expect(page.getByTestId('verilog-confirm')).toHaveCount(0);
  await expect(page.getByTestId('verilog-status')).toHaveText('No problems');

  await setSource(page, AND2);
  await page.getByTestId('verilog-examples').click();
  await page.getByTestId('verilog-example-alu').click();
  await expect(page.getByTestId('verilog-confirm')).toBeVisible();
  await page.getByRole('button', { name: 'Keep my text' }).click();
  await expect(page.locator('.cm-content')).toContainText('module and2');

  await page.getByTestId('verilog-build').click();
  await expect(page.getByTestId('crumb-here')).toHaveText('and2');
  await page.getByTestId('verilog-load-circuit').click();
  await expect(page.getByTestId('verilog-confirm')).toBeVisible();
  await page.getByTestId('verilog-confirm-replace').click();
  await expect(page.locator('.cm-content')).toContainText('module and2');
  await expect(page.locator('.cm-content')).not.toContainText('half_adder');
});

test('loading from a circuit that cannot be exported explains the fix', async ({ page }) => {
  await openVerilog(page);
  await page.getByTestId('verilog-load-circuit').click();
  await expect(page.getByTestId('toast')).toContainText('Pin parts');
});

test('a dark theme keeps the editor readable', async ({ page }) => {
  await openVerilog(page);
  await page.getByTestId('menu-file').click();
  await page.getByTestId('theme').click();
  const [bg, fg] = await page.locator('.cm-editor').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
  expect(bg).not.toBe(fg);
  await expect(page.locator('.cm-content')).toBeVisible();
});
