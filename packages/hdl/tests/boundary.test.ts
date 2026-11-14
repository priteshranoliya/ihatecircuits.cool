import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|tsx|mts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)].map((m) => m[1]!);
}

describe('hdl package boundary', () => {
  it('never imports @ihatecircuits/core or any path outside packages/hdl', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(file)) {
        const where = `${relative(PKG, file)} imports '${spec}'`;
        if (spec === '@ihatecircuits/core' || spec.startsWith('@ihatecircuits/core/')) violations.push(where);
        else if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (target !== PKG && !target.startsWith(PKG + sep)) violations.push(where);
        } else if (spec.startsWith('/')) violations.push(where);
      }
    }
    expect(violations).toEqual([]);
  });
});
