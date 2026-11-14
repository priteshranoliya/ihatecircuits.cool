import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { compIds, dragBetween, dropPart, fresh, newProject, openExample, pin, showCategory } from './helpers';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await fresh(page);
});
test.afterEach(() => expect(errors, 'browser errors').toEqual([]));

test('first visit shows a working half adder', async ({ page }) => {
  const [a, b] = await compIds(page, 'switch');
  const [s, c] = await compIds(page, 'led');
  const S = page.locator(`[data-comp="${s}"] .led`);
  const C = page.locator(`[data-comp="${c}"] .led`);
  await expect(S).not.toHaveClass(/\bon\b/);
  await page.locator(`[data-comp="${a}"]`).click();
  await expect(S).toHaveClass(/\bon\b/);
  await page.locator(`[data-comp="${b}"]`).click();
  await expect(S).not.toHaveClass(/\bon\b/);
  await expect(C).toHaveClass(/\bon\b/);
});

test('build from scratch: place, wire, simulate, undo, redo, delete', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'switch', 200, 200, 'Inputs');
  await dropPart(page, 'not', 380, 200, 'Gates');
  await dropPart(page, 'led', 560, 200, 'Outputs');
  const [sw] = await compIds(page, 'switch');
  const [inv] = await compIds(page, 'not');
  const [led] = await compIds(page, 'led');
  await dragBetween(page, pin(sw, 'out'), pin(inv, 'in0'));
  await dragBetween(page, pin(led, 'in'), pin(inv, 'out'));
  await expect(page.locator('.wires .wire')).toHaveCount(2);
  const L = page.locator(`[data-comp="${led}"] .led`);
  await expect(L).toHaveClass(/\bon\b/);
  await page.locator(`[data-comp="${sw}"]`).click();
  await expect(L).not.toHaveClass(/\bon\b/);
  await page.getByTestId('undo').click();
  await expect(page.locator('.wires .wire')).toHaveCount(1);
  await expect(page.locator(`[data-comp="${sw}"] .toggle`)).toHaveClass(/\bon\b/);
  await page.getByTestId('redo').click();
  await expect(page.locator('.wires .wire')).toHaveCount(2);
  await page.locator(`[data-comp="${inv}"]`).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.parts .part')).toHaveCount(2);
  await expect(page.locator('.wires .wire')).toHaveCount(0);
});

test('command palette places a part and runs actions', async ({ page }) => {
  await newProject(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search parts and actions' }).fill('flip flop d');
  await page.keyboard.press('Enter');
  await expect(page.locator('.parts .part-dff')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search parts and actions' }).fill('help');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help-dialog')).toBeVisible();
});

test('multi-bit pin: click bits to set a bus value, probe shows it', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'pin', 200, 200, 'Wiring');
  const [p] = await compIds(page, 'pin');
  // Clicking an input pin selects it and also flips its bit (here bit 0 → 1).
  await page.locator(`[data-comp="${p}"]`).click();
  await page.locator('#prop-bits').selectOption('4');
  await dropPart(page, 'probe', 420, 200, 'Wiring');
  const [probe] = await compIds(page, 'probe');
  await dragBetween(page, pin(p, 'p'), pin(probe, 'p'));
  await expect(page.locator(`[data-comp="${probe}"] .probe-text`)).toHaveText('0001');
  await page.locator(`[data-comp="${p}"] [data-pin-bit="2"]`).click();
  await expect(page.locator(`[data-comp="${probe}"] .probe-text`)).toHaveText('0101');
  await page.locator(`[data-comp="${p}"] [data-pin-bit="0"]`).click();
  await expect(page.locator(`[data-comp="${probe}"] .probe-text`)).toHaveText('0100');
  await expect(page.locator('.wire.bus')).toHaveCount(1);
});

test('tri-state bus example shows floating, a value, and a conflict', async ({ page }) => {
  await openExample(page, 'tristate-bus');
  const probe = page.locator('.part-probe .probe-text');
  await expect(probe).toHaveText('ZZZZ');
  const switches = await compIds(page, 'switch');
  await page.locator(`[data-comp="${switches[0]}"]`).click();
  await expect(probe).toHaveText('0x5');
  await page.locator(`[data-comp="${switches[1]}"]`).click();
  await expect(probe).toHaveText('EEEE');
  await expect(page.locator('.wire.ve').first()).toBeVisible();
});

test('subcircuits: open by double-click, add a circuit, place it', async ({ page }) => {
  await openExample(page, 'hierarchy');
  const subs = page.locator('.parts .part-sub');
  await expect(subs).toHaveCount(2);
  await subs.first().dblclick();
  await expect(page.locator('.crumbs .here')).toHaveText('Half adder');
  await expect(page.locator('.parts .part-xor')).toHaveCount(1);
  await page.getByTestId('circuit-main').click();
  await expect(page.locator('.crumbs .here')).toHaveText('Full adder');
  await page.getByTestId('add-circuit').click();
  await expect(page.locator('.crumbs .here')).toHaveText('New circuit');
  await showCategory(page, 'Circuits');
  // Both existing circuits are offered; the new circuit itself is not (it cannot contain itself).
  await expect(page.locator('[data-testid^="part-sub:"]')).toHaveCount(2);
  await expect(page.getByTestId('part-sub:k2')).toBeVisible();
  await page.getByTestId('part-sub:k2').click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 300, canvas.y + 200);
  await expect(page.locator('.parts .part-sub')).toHaveCount(1);
  // The full adder uses the half adder, so the half adder may not contain the full adder.
  // Both other circuits now contain the half adder, so neither may go inside it:
  // the "Your circuits" category disappears.
  await page.getByTestId('circuit-k2').click();
  await expect(page.locator('.crumbs .here')).toHaveText('Half adder');
  await expect(page.getByTestId('cat-Circuits')).toHaveCount(0);
});

test('clocked counter: step, run, reset, and the timing diagram records it', async ({ page }) => {
  await openExample(page, 'counter');
  for (let i = 0; i < 6; i++) await page.getByTestId('step').click();
  await expect(page.getByTestId('tick')).toHaveText('tick 6');
  await expect(page.locator('.part-hex .seg-on')).toHaveCount(5); // 3
  await page.getByTestId('run').click();
  await expect(page.getByTestId('tick')).not.toHaveText('tick 6', { timeout: 3000 });
  await page.getByTestId('run').click();
  await page.getByTestId('reset').click();
  await expect(page.getByTestId('tick')).toHaveText('tick 0');
  await expect(page.locator('.part-hex .seg-on')).toHaveCount(6); // 0
  await expect(page.locator('.tl-name')).not.toHaveCount(0);
});

test('analysis dialog: truth table and expressions for the majority voter', async ({ page }) => {
  await openExample(page, 'majority');
  await page.getByTestId('analyze').click();
  const dlg = page.getByTestId('analysis-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('tbody tr')).toHaveCount(8);
  await expect(dlg).toContainText('M');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('save and reopen a project file with several circuits', async ({ page }) => {
  await openExample(page, 'ripple4');
  const download = page.waitForEvent('download');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-save').click();
  const file = await (await download).path();
  const json = JSON.parse(await readFile(file, 'utf8'));
  expect(json.format).toBe('ihatecircuits-project');
  expect(json.circuits).toHaveLength(3);
  await newProject(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-open').click();
  await (await chooser).setFiles(file);
  await expect(page.locator('.parts .part-sub')).toHaveCount(4);
  await expect(page.locator('[data-testid^="circuit-"]')).toHaveCount(3);
});

test('broken files explain the problem and change nothing', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-open').click();
  await (await chooser).setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await expect(page.getByTestId('toast')).toContainText('not an iHateCircuits file');
  await expect(page.locator('.parts .part')).toHaveCount(6);
});

for (const format of ['svg', 'png', 'pdf'] as const) {
  test(`export ${format.toUpperCase()}`, async ({ page }) => {
    const download = page.waitForEvent('download');
    await page.getByTestId('menu-file').click();
    await page.getByTestId(`export-${format}`).click();
    const d = await download;
    const bytes = await readFile(await d.path());
    if (format === 'svg') {
      const text = bytes.toString('utf8');
      expect(text).toContain('<svg');
      expect(text).not.toContain('data-pin');
    }
    if (format === 'png') expect(bytes.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    if (format === 'pdf') expect(bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(bytes.length).toBeGreaterThan(500);
  });
}

test('wire bend drag and double-click reset', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'switch', 150, 150, 'Inputs');
  await dropPart(page, 'led', 450, 300, 'Outputs');
  const [sw] = await compIds(page, 'switch');
  const [led] = await compIds(page, 'led');
  await dragBetween(page, pin(sw, 'out'), pin(led, 'in'));
  const line = page.locator('.wires .wire .wire-line');
  const original = await line.getAttribute('d');
  const box = (await page.locator('.wires .wire .wire-hit').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 5 });
  await page.mouse.up();
  await expect(line).not.toHaveAttribute('d', original!);
  const moved = (await page.locator('.wires .wire .wire-hit').boundingBox())!;
  await page.mouse.dblclick(x + 60, moved.y + moved.height / 2);
  await expect(line).toHaveAttribute('d', original!);
});

test('oscillation is reported and outlined', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'switch', 150, 200, 'Inputs');
  await dropPart(page, 'nand', 350, 200, 'Gates');
  const [sw] = await compIds(page, 'switch');
  const [g] = await compIds(page, 'nand');
  await dragBetween(page, pin(sw, 'out'), pin(g, 'in0'));
  await dragBetween(page, pin(g, 'out'), pin(g, 'in1'));
  await page.locator(`[data-comp="${sw}"]`).click();
  await expect(page.getByTestId('oscillation-banner')).toBeVisible();
  await expect(page.locator('.hot-box')).toHaveCount(1);
  await page.locator(`[data-comp="${sw}"]`).click();
  await expect(page.getByTestId('oscillation-banner')).toHaveCount(0);
});

test('every example opens and settles', async ({ page }) => {
  for (const id of ['gates', 'half-adder', 'full-adder', 'majority', 'mux-gates', 'decoder', 'adder4', 'tristate-bus', 'wired-and', 'cmos-nand', 'hazard', 'sr-latch', 'counter', 'shift-register', 'hierarchy', 'ripple4']) {
    await openExample(page, id);
    await expect(page.getByTestId('oscillation-banner')).toHaveCount(0);
    expect(await page.locator('.parts .part').count()).toBeGreaterThan(2);
  }
});

test('autosave survives a reload', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'xor', 300, 200, 'Gates');
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('.parts .part-xor')).toHaveCount(1);
});

test('tools, focus mode, context menu and breadcrumbs', async ({ page }) => {
  await openExample(page, 'hierarchy');
  // Right-click a part: a menu scoped to it, with shortcuts.
  const sub = page.locator('.parts .part-sub').first();
  const box = (await sub.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toContainText('Open “Half adder”');
  await menu.getByRole('menuitem', { name: /Open/ }).click();
  // The breadcrumb remembers where we came from; Esc goes back up.
  await expect(page.getByTestId('crumb-here')).toHaveText('Half adder');
  await expect(page.getByTestId('crumb-0')).toHaveText('Full adder');
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('crumb-here')).toHaveText('Full adder');
  // Focus mode hides both panels.
  await page.keyboard.press('\\');
  await expect(page.locator('.app.focus')).toHaveCount(1);
  await page.keyboard.press('\\');
  await expect(page.locator('.app.focus')).toHaveCount(0);
  // Text tool: click the canvas to add a note.
  await page.getByTestId('tool-text').click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 60, canvas.y + 60);
  await expect(page.locator('.parts .part-text')).toHaveCount(1);
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
});

test('favourites and recents in the library', async ({ page }) => {
  await newProject(page);
  await dropPart(page, 'xor', 300, 200, 'Gates');
  await expect(page.locator('.side-head h2', { hasText: 'Recent' })).toBeVisible();
  await page.getByTestId('part-and').first().hover();
  await page.getByTestId('part-and').first().getByRole('button', { name: 'Add AND to favourites' }).click();
  await expect(page.locator('.side-head h2', { hasText: 'Favourites' })).toBeVisible();
  await page.getByTestId('lib-filter').fill('flip');
  await expect(page.getByTestId('part-dff')).toBeVisible();
});

test('deleting offers an undo in the toast', async ({ page }) => {
  const [a] = await compIds(page, 'xor');
  await page.locator(`[data-comp="${a}"]`).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.parts .part-xor')).toHaveCount(0);
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.parts .part-xor')).toHaveCount(1);
});
