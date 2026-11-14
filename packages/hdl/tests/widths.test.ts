import { describe, expect, it } from 'vitest';
import { compile, type Cell } from '../src';
import { design, sim } from './ir-eval';

/**
 * IEEE 1364-2005 section 5.4: expression bit lengths. Each test states the
 * rule from the standard it checks.
 */

const cellsOf = (src: string, kind: Cell['kind']) => {
  const d = design(src);
  const m = d.modules.find((x) => x.name === d.top)!;
  return m.cells.filter((c) => c.kind === kind).map((c) => ({ c, width: m.nets[(c as { out: number }).out]!.width }));
};

describe('§5.4 context-determined operands are extended to the widest of all operands and the target', () => {
  const adder = `module m (input [7:0] a, input [7:0] b, output [8:0] y);
  assign y = a + b;
endmodule`;

  it('keeps the carry: an 8-bit + 8-bit sum assigned to 9 bits is a 9-bit add', () => {
    expect(cellsOf(adder, 'add').map((x) => x.width)).toEqual([9]);
    const s = sim(adder);
    s.set('a', 255).set('b', 1);
    expect(s.get('y')).toBe(256n);
    s.set('a', 200).set('b', 100);
    expect(s.get('y')).toBe(300n);
  });

  it('truncates when the target is narrower than the operands', () => {
    const s = sim(`module m (input [7:0] a, input [7:0] b, output [3:0] y);
  assign y = a + b;
endmodule`);
    s.set('a', 0x1f).set('b', 0x01);
    expect(s.get('y')).toBe(0x0n);
    s.set('a', 0x2a).set('b', 0x0b);
    expect(s.get('y')).toBe(0x5n);
  });

  it('zero-extends a narrower operand before adding, so the target width decides the carry', () => {
    const s = sim(`module m (input [3:0] a, input [7:0] b, output [8:0] y);
  assign y = a + b;
endmodule`);
    s.set('a', 15).set('b', 255);
    expect(s.get('y')).toBe(270n);
  });

  it('applies to bitwise operators: ~ inverts the extended operand, so the new high bits become 1', () => {
    const s = sim(`module m (input [3:0] a, output [7:0] y);
  assign y = ~a;
endmodule`);
    s.set('a', 0b0101);
    expect(s.get('y')).toBe(0b11111010n);
  });

  it('applies to &, | and ^ with mixed operand widths', () => {
    const s = sim(`module m (input [3:0] a, input [7:0] b, output [7:0] y1, output [7:0] y2, output [7:0] y3);
  assign y1 = a & b;
  assign y2 = a | b;
  assign y3 = a ^ b;
endmodule`);
    s.set('a', 0b1111).set('b', 0b10100101);
    expect(s.get('y1')).toBe(0b00000101n);
    expect(s.get('y2')).toBe(0b10101111n);
    expect(s.get('y3')).toBe(0b10101010n);
  });

  it('xnor is the complement of xor at the context width', () => {
    const s = sim(`module m (input [3:0] a, input [3:0] b, output [3:0] y, output [3:0] z);
  assign y = a ~^ b;
  assign z = a ^~ b;
endmodule`);
    s.set('a', 0b1100).set('b', 0b1010);
    expect(s.get('y')).toBe(0b1001n);
    expect(s.get('z')).toBe(0b1001n);
  });

  it('?: branches are extended to the widest branch and the target; the condition stands alone', () => {
    const src = `module m (input [2:0] s, input [7:0] a, input [3:0] b, output [8:0] y);
  assign y = s ? a : b;
endmodule`;
    const r = sim(src);
    r.set('a', 0xff).set('b', 0x5).set('s', 0);
    expect(r.get('y')).toBe(0x5n);
    r.set('s', 4);
    expect(r.get('y')).toBe(0xffn);
    expect(cellsOf(src, 'mux').map((x) => x.width)).toEqual([9]);
  });

  it('a multi-bit ?: condition is true when any of its bits is 1', () => {
    const s = sim(`module m (input [3:0] c, output y);
  assign y = c ? 1'b1 : 1'b0;
endmodule`);
    s.set('c', 0);
    expect(s.get('y')).toBe(0n);
    s.set('c', 0b1000);
    expect(s.get('y')).toBe(1n);
  });
});

describe('§5.4 == and != give 1 bit and size their operands to the comparison alone', () => {
  it('the result is 1 bit, then zero-extended into a wider target', () => {
    const src = `module m (input [7:0] a, input [7:0] b, output [8:0] y);
  assign y = a == b;
endmodule`;
    expect(cellsOf(src, 'eq').map((x) => x.width)).toEqual([1]);
    const s = sim(src);
    s.set('a', 5).set('b', 5);
    expect(s.get('y')).toBe(1n);
    s.set('b', 6);
    expect(s.get('y')).toBe(0n);
  });

  it('operands are extended to max(lhs, rhs), not to the target: carry inside the comparison is kept when the other side is wider', () => {
    const s = sim(`module m (input [7:0] a, input [7:0] b, input [8:0] c, output e);
  assign e = (a + b) == c;
endmodule`);
    s.set('a', 0x80).set('b', 0x80).set('c', 0x100);
    expect(s.get('e')).toBe(1n);
  });

  it('...but without a wider side the sum wraps inside the comparison', () => {
    const s = sim(`module m (input [7:0] a, input [7:0] b, input [7:0] c, output e);
  assign e = (a + b) == c;
endmodule`);
    s.set('a', 0x80).set('b', 0x80).set('c', 0);
    expect(s.get('e')).toBe(1n);
  });

  it('is not sized by a wider assignment target', () => {
    const src = `module m (input [7:0] a, input [7:0] b, input [7:0] c, output [15:0] e);
  assign e = (a + b) == c;
endmodule`;
    const s = sim(src);
    s.set('a', 0xff).set('b', 0x01).set('c', 0x00);
    expect(s.get('e')).toBe(1n);
    expect(cellsOf(src, 'eq')[0]!.c).toMatchObject({ kind: 'eq' });
    const add = cellsOf(src, 'add');
    expect(add.map((x) => x.width)).toEqual([8]);
  });

  it('!= is the complement, and an unsized literal makes the comparison 32 bits wide', () => {
    const s = sim(`module m (input [3:0] a, output ne, output eq1);
  assign ne = a != 4'd3;
  assign eq1 = (a + 15) == 1;
endmodule`);
    s.set('a', 3);
    expect(s.get('ne')).toBe(0n);
    s.set('a', 4);
    expect(s.get('ne')).toBe(1n);
    s.set('a', 2);
    // 2 + 15 = 17 in 32 bits, which is not 1; wrapping at 4 bits would give 1.
    expect(s.get('eq1')).toBe(0n);
    s.set('a', 0xf);
    expect(s.get('eq1')).toBe(0n);
  });

  it('a nested comparison is a 1-bit operand that extends with zeros', () => {
    const s = sim(`module m (input [3:0] a, input [3:0] b, output [3:0] y);
  assign y = (a == b) + 4'd2;
endmodule`);
    s.set('a', 1).set('b', 1);
    expect(s.get('y')).toBe(3n);
    s.set('b', 2);
    expect(s.get('y')).toBe(2n);
  });
});

describe('§5.4 selects and concatenation are self-determined', () => {
  it('a bit-select is 1 bit and a part-select [msb:lsb] is msb-lsb+1 bits', () => {
    const s = sim(`module m (input [7:0] a, output b3, output [3:0] hi, output [2:0] mid);
  assign b3 = a[3];
  assign hi = a[7:4];
  assign mid = a[6:4];
endmodule`);
    s.set('a', 0b10110101);
    expect(s.get('b3')).toBe(0n);
    expect(s.get('hi')).toBe(0b1011n);
    expect(s.get('mid')).toBe(0b011n);
  });

  it('a part-select keeps its own width inside a wider expression, so the sum below cannot carry into bit 4', () => {
    const src = `module m (input [7:0] a, output [4:0] y);
  assign y = a[7:4] + a[3:0];
endmodule`;
    const s = sim(src);
    s.set('a', 0xff);
    expect(s.get('y')).toBe(30n);
    expect(cellsOf(src, 'add').map((x) => x.width)).toEqual([5]);
  });

  it('a concatenation is as wide as its parts together and is not stretched by context', () => {
    const s = sim(`module m (input [3:0] a, input [3:0] b, output [7:0] y, output [8:0] z);
  assign y = {a, b};
  assign z = {a, b};
endmodule`);
    s.set('a', 0xa).set('b', 0x5);
    expect(s.get('y')).toBe(0xa5n);
    expect(s.get('z')).toBe(0x0a5n);
  });

  it('truncates a concatenation wider than the target (keeping the low bits)', () => {
    const s = sim(`module m (input [3:0] a, input [3:0] b, output [5:0] y);
  assign y = {a, b};
endmodule`);
    s.set('a', 0xa).set('b', 0x5);
    expect(s.get('y')).toBe(0b100101n);
  });

  it('concatenation parts can be selects and sized literals', () => {
    const s = sim(`module m (input [7:0] a, output [9:0] y);
  assign y = {a[0], 1'b0, a[7:4], 4'd5};
endmodule`);
    s.set('a', 0b1011_0001);
    expect(s.get('y')).toBe(0b1_0_1011_0101n);
  });

  it('an unsized literal inside a concatenation is an error, as in the standard', () => {
    const r = compile('module m (input [3:0] a, output [7:0] y);\n  assign y = {a, 5};\nendmodule');
    expect(r.diagnostics[0]).toMatchObject({ code: 'bad-width', severity: 'error', span: { line: 2, col: 18 } });
  });

  it('a concatenation inside a sum is stretched to the context width as one operand', () => {
    const s = sim(`module m (input [3:0] a, input [3:0] b, input [8:0] c, output [8:0] y);
  assign y = {a, b} + c;
endmodule`);
    s.set('a', 0xf).set('b', 0xf).set('c', 1);
    expect(s.get('y')).toBe(256n);
  });
});

describe('§3.5.1 and §5.4: unsized literals are 32 bits', () => {
  it('count as 32 bits when sizing an expression, so ~ of an unsized 0 fills the whole target', () => {
    const s = sim(`module m (output [7:0] y, output [3:0] z);
  assign y = ~0;
  assign z = 5 + 14;
endmodule`);
    expect(s.get('y')).toBe(0xffn);
    expect(s.get('z')).toBe(3n);
  });

  it('sized and unsized literals agree on value', () => {
    const s = sim(`module m (output [7:0] a, output [7:0] b, output [7:0] c, output [7:0] d);
  assign a = 200;
  assign b = 8'hC8;
  assign c = 3'd5;
  assign d = 4'b1010;
endmodule`);
    expect([s.get('a'), s.get('b'), s.get('c'), s.get('d')]).toEqual([200n, 200n, 5n, 10n]);
  });

  it('assignment truncates an unsized literal wider than the target', () => {
    const s = sim(`module m (output [3:0] y);
  assign y = 300;
endmodule`);
    expect(s.get('y')).toBe(300n & 15n);
  });

  it('builds narrow circuits: the 32-bit context does not create a 32-bit adder for a 4-bit target', () => {
    const adds = cellsOf('module m (input [3:0] a, output [3:0] y);\n  assign y = a + 1;\nendmodule', 'add');
    expect(adds.map((x) => x.width)).toEqual([4]);
  });
});

describe('width limits and select checks', () => {
  it('rejects values wider than 32 bits with a span', () => {
    const r = compile('module m (input [31:0] a, input [31:0] b, output [32:0] y);\n  assign y = a + b;\nendmodule');
    expect(r.diagnostics[0]).toMatchObject({ code: 'width-limit', span: { line: 1, col: 50 } });
  });

  it('rejects a comparison that would need more than 64 bits', () => {
    const r = compile('module m (input [31:0] a, input [31:0] b, output y);\n  assign y = {a, b, a} == {b, a, b};\nend'.replace('\nend', '\nendmodule'));
    expect(r.diagnostics.map((d) => d.code)).toContain('width-limit');
  });

  it('compares up to 64 bits by evaluating a low and a high half', () => {
    const s = sim('module m (input [31:0] a, input [31:0] b, output y, output z);\n  assign y = {a, b} == {b, a};\n  assign z = {a, b} != {b, a};\nendmodule');
    s.set('a', 7).set('b', 7);
    expect([s.get('y'), s.get('z')]).toEqual([1n, 0n]);
    s.set('b', 9);
    expect([s.get('y'), s.get('z')]).toEqual([0n, 1n]);
  });

  it('checks bit and part selects against the vector', () => {
    const r = compile('module m (input [7:0] a, output y, output [3:0] z);\n  assign y = a[8];\n  assign z = a[2:5];\nendmodule');
    expect(r.diagnostics.map((d) => [d.code, d.span.line])).toEqual([['bad-select', 2], ['bad-select', 3]]);
  });

  it('keeps the part of a sum that fits a 32-bit target', () => {
    const s = sim('module m (input [31:0] a, input [31:0] b, output [31:0] y);\n  assign y = a + b;\nendmodule');
    s.set('a', 0xffffffff).set('b', 2);
    expect(s.get('y')).toBe(1n);
  });
});
