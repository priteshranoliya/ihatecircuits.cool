import { expect, type Page } from '@playwright/test';

export async function fresh(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Ids of the parts of a type on the canvas, in creation order. */
export async function compIds(page: Page, type?: string): Promise<string[]> {
  const sel = type ? `.parts .part-${type}` : '.parts .part';
  const ids = await page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-comp')!));
  return ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export async function center(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function dragBetween(page: Page, from: string, to: string) {
  const a = await center(page, from);
  const b = await center(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

export const pin = (comp: string, name: string) => `[data-pin="${comp}:${name}"] .pin-hit`;

/** Make sure a sidebar category is expanded so its parts are visible. */
export async function showCategory(page: Page, cat: string) {
  const btn = page.getByTestId(`cat-${cat}`);
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
}

/** Drag a part from the sidebar to canvas-relative coordinates. */
export async function dropPart(page: Page, type: string, x: number, y: number, cat?: string) {
  if (cat) await showCategory(page, cat);
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.locator(`[data-testid="part-${type}"]`).scrollIntoViewIfNeeded();
  const src = await center(page, `[data-testid="part-${type}"]`);
  await page.mouse.move(src.x, src.y);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y, { steps: 3 });
  await page.mouse.move(canvas.x + x, canvas.y + y, { steps: 6 });
  await page.mouse.up();
}

export async function newProject(page: Page) {
  await page.getByTestId('menu-file').click();
  await page.getByTestId('menu-new').click();
  await expect(page.locator('.parts .part')).toHaveCount(0);
}

export async function openExample(page: Page, id: string) {
  await page.getByTestId('open-examples').click();
  await page.getByTestId(`example-${id}`).click();
  await expect(page.getByTestId('examples-dialog')).toHaveCount(0);
}
