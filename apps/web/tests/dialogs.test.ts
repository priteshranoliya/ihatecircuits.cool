import { describe, expect, it } from 'vitest';
import '@ihatecircuits/core/parts';
import { kmap, type Cell } from '@ihatecircuits/core/analysis';
import { emptyCircuit, addComponent } from '@ihatecircuits/core/edit';
import { groupRects, parseBuildLines, parseHexWord, parseHexWords, scrollToReveal, testTemplate, visibleRows, wordsToText } from '../src/ui/dialogs/dialogHelpers';

const map4 = () => kmap(4, Array<Cell>(16).fill(0), ['A', 'B', 'C', 'D'])!;

describe('groupRects', () => {
  it('draws a contiguous group as one rectangle', () => {
    // A′B′ = rows 00 (index 0), all columns
    const r = groupRects(map4(), '00--');
    expect(r).toEqual([{ r0: 0, r1: 0, c0: 0, c1: 3, openTop: false, openBottom: false, openLeft: false, openRight: false }]);
  });

  it('splits a group that wraps columns into two pieces open at the edges', () => {
    // B′D′ : cols with D=0 are Gray codes 00 and 10 = indices 0 and 3, rows with B=0: 00, 10 = indices 0 and 3
    const r = groupRects(map4(), '-0-0');
    expect(r).toHaveLength(4);
    const corner = r.find((x) => x.r0 === 0 && x.c0 === 0)!;
    expect(corner.openTop).toBe(true);
    expect(corner.openLeft).toBe(true);
    expect(corner.openBottom).toBe(false);
    const opposite = r.find((x) => x.r0 === 3 && x.c0 === 3)!;
    expect(opposite.openBottom).toBe(true);
    expect(opposite.openRight).toBe(true);
  });

  it('covers the whole map with one piece for the constant-true term', () => {
    expect(groupRects(map4(), '----')).toHaveLength(1);
  });
});

describe('hex words', () => {
  it('cuts words to the data width and rejects non-hex', () => {
    expect(parseHexWord('1FF', 8)).toBe(0xff);
    expect(parseHexWord('0x0a', 8)).toBe(10);
    expect(parseHexWord('xyz', 8)).toBeNull();
    expect(parseHexWord('', 8)).toBeNull();
  });
  it('parses a file, reports the first bad token and drops overflow', () => {
    expect(parseHexWords('1 2\n3', 4, 8).words).toEqual([1, 2, 3]);
    expect(parseHexWords('1 zz 3', 4, 8).bad).toEqual({ token: 'zz', index: 1 });
    const over = parseHexWords('1 2 3 4 5', 4, 3);
    expect(over.words).toEqual([1, 2, 3]);
    expect(over.dropped).toBe(2);
  });
  it('writes words without trailing zeros, in rows', () => {
    expect(wordsToText([1, 0, 255, 0, 0], 8, 0)).toBe('01 00 FF');
    expect(wordsToText([1, 2, 3], 8, 2)).toBe('01 02\n03');
    expect(wordsToText([0, 0], 8, 4)).toBe('');
  });
});

describe('windowing', () => {
  it('selects visible rows with overscan, clamped', () => {
    expect(visibleRows(0, 100, 10, 1000, 2)).toEqual({ start: 0, end: 12 });
    expect(visibleRows(500, 100, 10, 55, 2)).toEqual({ start: 48, end: 55 });
  });
  it('scrolls only when the row is out of view', () => {
    expect(scrollToReveal(5, 0, 100, 10)).toBeNull();
    expect(scrollToReveal(20, 0, 100, 10)).toBe(110);
    expect(scrollToReveal(1, 50, 100, 10)).toBe(10);
  });
});

describe('parseBuildLines', () => {
  it('reads outputs and sorted inputs', () => {
    const r = parseBuildLines('F = A·B + A′C\n\n# note\nG = C ^ B');
    expect(r.problems).toEqual([]);
    expect(r.outputs.map((o) => o.name)).toEqual(['F', 'G']);
    expect(r.inputs).toEqual(['A', 'B', 'C']);
  });
  it('reports the line and column of a parse error', () => {
    const r = parseBuildLines('F = A + B\nG = A + ');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].line).toBe(2);
    expect(r.problems[0].column).toBeGreaterThan(4);
  });
  it('rejects a missing =, bad names and duplicates', () => {
    expect(parseBuildLines('A + B').problems[0].line).toBe(1);
    expect(parseBuildLines('1x = A').problems[0].message).toMatch(/not a usable/);
    expect(parseBuildLines('F = A\nF = B').problems[0].line).toBe(2);
  });
});

describe('testTemplate', () => {
  it('builds a header from labelled ports with x outputs', () => {
    let c = emptyCircuit('t');
    c = addComponent(c, { type: 'switch', x: 0, y: 0, label: 'A' }).circuit;
    c = addComponent(c, { type: 'switch', x: 0, y: 40, label: 'B' }).circuit;
    c = addComponent(c, { type: 'led', x: 100, y: 0, label: 'Y' }).circuit;
    const lines = testTemplate(c).split('\n');
    expect(lines[1]).toBe('A  B  Y');
    expect(lines[2]).toBe('0  0  x');
    expect(lines[3]).toBe('1  1  x');
  });
});
