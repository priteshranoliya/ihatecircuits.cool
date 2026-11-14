import { expect, type Page } from '@playwright/test';

/** Replace the editor text. insertText skips auto-indent, so the text lands as written. */
export async function setSource(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

export async function openVerilog(page: Page) {
  await page.getByTestId('open-verilog').click();
  await expect(page.getByTestId('verilog-panel')).toBeVisible();
  await expect(page.locator('.cm-content')).toBeVisible();
}

export const outBit = (id: string, bit = 0) => `[data-comp="${id}"] [data-pin-bit="${bit}"]`;

export const AND2 = 'module and2(input a, input b, output y);\n  assign y = a & b;\nendmodule\n';
export const ADD8 = 'module add8(input [7:0] a, input [7:0] b, output [7:0] s);\n  assign s = a + b;\nendmodule\n';
