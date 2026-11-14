import { describe, expect, it } from 'vitest';
import { expressions, truthTable } from '../src/analysis';
import { equalAst, evaluate, format, mkAnd, mkConst, mkNot, mkOr, mkVar, mkXor, parse, sortVariables, toTruthTable, variables, type AST, type FormatStyle } from '../src/expr';

const ok = (text: string, names?: string[]): AST => {
  const r = parse(text, { names });
  if ('error' in r) throw new Error(`${text}: ${r.error.message}`);
  return r.ast;
};
const A = mkVar('A');
const B = mkVar('B');
const C = mkVar('C');

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
function randomAst(rand: () => number, vars: string[], depth: number): AST {
  if (depth === 0 || rand() < 0.25) return rand() < 0.1 ? mkConst(rand() < 0.5 ? 0 : 1) : mkVar(vars[Math.floor(rand() * vars.length)]);
  const r = rand();
  if (r < 0.25) return mkNot(randomAst(rand, vars, depth - 1));
  const n = 2 + Math.floor(rand() * 2);
  const args = Array.from({ length: n }, () => randomAst(rand, vars, depth - 1));
  return r < 0.55 ? mkAnd(...args) : r < 0.85 ? mkOr(...args) : mkXor(...args);
}
const same = (a: AST, b: AST, vars: string[]) => {
  for (let r = 0; r < 1 << vars.length; r++) {
    const asg = Object.fromEntries(vars.map((v, i) => [v, (r >> i) & 1]));
    if (evaluate(a, asg) !== evaluate(b, asg)) return false;
  }
  return true;
};

describe('expression parser', () => {
  it('precedence: NOT, AND, XOR, OR', () => {
    expect(ok('A + B C')).toEqual(mkOr(A, mkAnd(B, C)));
    expect(ok('A + B ^ C')).toEqual(mkOr(A, mkXor(B, C)));
    expect(ok('A ^ B C')).toEqual(mkXor(A, mkAnd(B, C)));
    expect(ok('A + B ^ C & D')).toEqual(mkOr(A, mkXor(B, mkAnd(C, mkVar('D')))));
    expect(ok('A·B′')).toEqual(mkAnd(A, mkNot(B)));
    expect(ok('~A & B')).toEqual(mkAnd(mkNot(A), B));
    expect(ok('(A + B)C')).toEqual(mkAnd(mkOr(A, B), C));
    expect(ok('(A + B)′')).toEqual(mkNot(mkOr(A, B)));
  });

  it('every NOT notation', () => {
    for (const t of ["A'", 'A′', '~A', '!A', '¬A', 'NOT A', 'not A', "(A)'", '~~~A', "A''' "]) {
      const ast = ok(t);
      expect(variables(ast)).toEqual(['A']);
      expect(evaluate(ast, { A: 0 })).toBe(1);
      expect(evaluate(ast, { A: 1 })).toBe(0);
    }
    expect(ok("A''")).toEqual(mkNot(mkNot(A)));
  });

  it('every AND, OR and XOR notation', () => {
    for (const t of ['A·B', 'A*B', 'A&B', 'A&&B', 'A∧B', 'A AND B', 'A and B', 'AB', 'A B']) expect(ok(t)).toEqual(mkAnd(A, B));
    for (const t of ['A+B', 'A|B', 'A||B', 'A∨B', 'A OR B', 'A or B']) expect(ok(t)).toEqual(mkOr(A, B));
    for (const t of ['A^B', 'A⊕B', 'A XOR B', 'A xor B']) expect(ok(t)).toEqual(mkXor(A, B));
  });

  it('notations mix', () => {
    const ast = ok("A·!B + C′ ∧ D | E ^ F");
    expect(ast.k).toBe('or');
    expect(variables(ast)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('constants', () => {
    expect(ok('A + 1')).toEqual(mkOr(A, mkConst(1)));
    expect(ok('0')).toEqual(mkConst(0));
    expect(ok("1'")).toEqual(mkNot(mkConst(1)));
  });

  it('juxtaposition works only with single-letter variables', () => {
    expect(ok("AB'C + A'B")).toEqual(mkOr(mkAnd(A, mkNot(B), C), mkAnd(mkNot(A), B)));
    expect(ok('ABC')).toEqual(mkAnd(A, B, C));
    expect(ok('A(B + C)')).toEqual(mkAnd(A, mkOr(B, C)));
    expect(ok('(A + B)(A + C)')).toEqual(mkAnd(mkOr(A, B), mkOr(A, C)));
    expect(ok('A~B')).toEqual(mkAnd(A, mkNot(B)));
    expect(ok('A B', ['A', 'B'])).toEqual(mkAnd(A, B));
    // multi-letter names need operators
    expect(ok('Cin & A')).toEqual(mkAnd(mkVar('Cin'), A));
    expect(ok('B1 + D_0')).toEqual(mkOr(mkVar('B1'), mkVar('D_0')));
    const bad = parse('Cin A');
    expect('error' in bad && bad.error.message).toMatch(/operator/);
    expect('error' in parse('A1 B1')).toBe(true);
    // a name list with a long name stops letter splitting even for "Cin"-like text
    expect(ok('Cin + A', ['Cin', 'A'])).toEqual(mkOr(mkVar('Cin'), A));
    expect('error' in parse('Cin A', { names: ['Cin', 'A'] })).toBe(true);
  });

  it('flattens same-kind chains', () => {
    expect(ok('A + (B + C)')).toEqual({ k: 'or', args: [A, B, C] });
    expect(ok('A & B & C')).toEqual({ k: 'and', args: [A, B, C] });
  });

  it('variable names and order', () => {
    expect(variables(ok('Cin + A·B1 + Cin'))).toEqual(['Cin', 'A', 'B1']);
    expect(sortVariables(['B10', 'B2', 'Cin', 'A', 'B1'])).toEqual(['A', 'B1', 'B2', 'B10', 'Cin']);
  });

  it('evaluates', () => {
    const ast = ok("A·B′ + C");
    expect(evaluate(ast, { A: 1, B: 0, C: 0 })).toBe(1);
    expect(evaluate(ast, { A: 1, B: 1, C: 0 })).toBe(0);
    expect(evaluate(ast, { A: false, B: true, C: true })).toBe(1);
    expect(() => evaluate(ast, { A: 1 })).toThrow();
    expect(evaluate(ok('A ^ B ^ C'), { A: 1, B: 1, C: 1 })).toBe(1);
  });
});

describe('parse errors', () => {
  const err = (t: string) => {
    const r = parse(t);
    if (!('error' in r)) throw new Error(`expected an error for ${t}`);
    return r.error;
  };
  it('reports a missing closing parenthesis after the last position', () => {
    const e = err('(A + B');
    expect(e.message).toBe('Expected a closing parenthesis after position 6');
    expect(e.index).toBe(6);
    expect(err('A + (B·(C + D)').message).toBe('Expected a closing parenthesis after position 14');
  });
  it('reports an unmatched closing parenthesis', () => {
    const e = err('A + B)');
    expect(e.message).toMatch(/Unexpected closing parenthesis at position 6/);
    expect(e.index).toBe(5);
    expect(err(')A').index).toBe(0);
  });
  it('reports a dangling operator', () => {
    const e = err('A +');
    expect(e.message).toMatch(/ends too early/);
    expect(e.index).toBe(3);
    expect(err('A + + B').index).toBe(4);
    expect(err('* A').index).toBe(0);
  });
  it('reports bad characters and constants', () => {
    const e = err('A % B');
    expect(e.message).toBe('Unexpected character "%" at position 3');
    expect(e.index).toBe(2);
    expect(err('A + 2').message).toMatch(/Only 0 and 1/);
    expect(err('A + 2').index).toBe(4);
    expect(err('1A').message).toMatch(/start with a letter/);
  });
  it('reports empty input, empty parentheses and a stray prime', () => {
    expect(err('   ').message).toMatch(/Type an expression/);
    expect(err('A + ()').message).toMatch(/Empty parentheses at position 5/);
    expect(err("'A").message).toMatch(/must follow a variable/);
  });
  it('never throws on arbitrary junk', () => {
    const rand = rng(3);
    const alphabet = "AB C()+·'′~!&|^⊕01 x_9%$";
    for (let k = 0; k < 500; k++) {
      const s = Array.from({ length: Math.floor(rand() * 12) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const r = parse(s);
      if ('error' in r) {
        expect(r.error.index).toBeGreaterThanOrEqual(0);
        expect(r.error.index).toBeLessThanOrEqual(s.length);
        expect(r.error.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('format', () => {
  const sample = mkOr(mkAnd(A, mkNot(B)), C);
  it('four styles', () => {
    expect(format(sample, 'math')).toBe('A·B′ + C');
    expect(format(sample, 'logic')).toBe('A ∧ ¬B ∨ C');
    expect(format(sample, 'code')).toBe('A && !B || C');
    expect(format(sample, 'bits')).toBe('A & ~B | C');
  });
  it('uses the fewest parentheses', () => {
    expect(format(mkAnd(mkOr(A, B), C), 'math')).toBe('(A + B)·C');
    expect(format(mkAnd(A, mkXor(B, C)), 'bits')).toBe('A & (B ^ C)');
    expect(format(mkXor(A, mkAnd(B, C)), 'bits')).toBe('A ^ B & C');
    expect(format(mkXor(mkOr(A, B), C), 'bits')).toBe('(A | B) ^ C');
    expect(format(mkOr(mkXor(A, B), C), 'bits')).toBe('A ^ B | C');
    expect(format(mkNot(mkOr(A, B)), 'math')).toBe('(A + B)′');
    expect(format(mkNot(mkAnd(A, B)), 'code')).toBe('!(A && B)');
    expect(format(mkNot(mkNot(A)), 'math')).toBe('A′′');
    expect(format(mkNot(mkNot(A)), 'logic')).toBe('¬¬A');
    expect(format(mkConst(1), 'math')).toBe('1');
  });
  it('round-trips through parse for random expressions in every style', () => {
    const rand = rng(11);
    const vars = ['A', 'B', 'C', 'D'];
    for (const style of ['math', 'logic', 'code', 'bits'] as FormatStyle[])
      for (let k = 0; k < 150; k++) {
        const ast = randomAst(rand, vars, 4);
        const text = format(ast, style);
        const back = parse(text, { names: vars });
        if ('error' in back) throw new Error(`${style}: ${text} -> ${back.error.message}`);
        expect(same(ast, back.ast, vars)).toBe(true);
        // printing again gives the same text: the printed form is stable
        expect(format(back.ast, style)).toBe(text);
      }
  });
  it('round-trips structurally for parsed expressions', () => {
    for (const t of ["A·B′ + C", 'A ^ B & (C | D)', "(A + B)′ + A'B", 'A + B + C']) {
      const ast = ok(t);
      for (const style of ['math', 'logic', 'code', 'bits'] as FormatStyle[]) expect(equalAst(ok(format(ast, style)), ast)).toBe(true);
    }
  });
  it('multi-letter names print and re-parse', () => {
    const ast = mkOr(mkAnd(mkVar('Cin'), mkVar('Sel1')), mkNot(mkVar('D_0')));
    expect(format(ast, 'math')).toBe('Cin·Sel1 + D_0′');
    expect(equalAst(ok(format(ast, 'math')), ast)).toBe(true);
  });
});

describe('truth tables from expressions', () => {
  it('row r spells r with the first input as the most significant bit', () => {
    const t = toTruthTable([{ name: 'Y', ast: ok('A·B′ + C') }], ['A', 'B', 'C']);
    if ('error' in t) throw new Error(t.error);
    expect(t.rows).toHaveLength(8);
    t.rows.forEach((row, r) => {
      expect(row.inputs.join('')).toBe(r.toString(2).padStart(3, '0'));
      const [a, b, c] = row.inputs;
      expect(row.outputs[0]).toBe((a && !b) || c ? 1 : 0);
    });
    expect(t.inputs.map((c) => c.name)).toEqual(['A', 'B', 'C']);
    expect(t.outputs.map((c) => c.name)).toEqual(['Y']);
    expect(t.hasMemory).toBe(false);
  });
  it('agrees with evaluate on random expressions and feeds analysis.expressions', () => {
    const rand = rng(5);
    const vars = ['A', 'B', 'C', 'D'];
    for (let k = 0; k < 60; k++) {
      const ast = randomAst(rand, vars, 4);
      const t = toTruthTable([{ name: 'Y', ast }], vars);
      if ('error' in t) throw new Error(t.error);
      t.rows.forEach((row, r) => {
        const asg = Object.fromEntries(vars.map((v, i) => [v, (r >> (3 - i)) & 1]));
        expect(row.outputs[0]).toBe(evaluate(ast, asg));
      });
      const [ex] = expressions(t);
      // The minimised SOP reproduces the table.
      for (let r = 0; r < 16; r++) expect(ex.minterms.includes(r)).toBe(t.rows[r].outputs[0] === 1);
    }
  });
  it('reports a variable missing from the inputs', () => {
    const t = toTruthTable([{ name: 'Y', ast: ok('A + Z') }], ['A', 'B']);
    expect('error' in t && t.error).toMatch(/Z/);
    expect('error' in toTruthTable([], [])).toBe(true);
  });
  it('has the same shape as a simulated table', async () => {
    const { T } = await import('./helpers');
    const t = new T();
    const a = t.add('switch', {}, 'A');
    const b = t.add('switch', {}, 'B');
    const g = t.add('and', {});
    const y = t.add('led', {}, 'Y');
    t.wire(a, 'out', g, 'in0').wire(b, 'out', g, 'in1').wire(g, 'out', y, 'in');
    const sim = truthTable(t.c, t.sim());
    const mine = toTruthTable([{ name: 'Y', ast: ok('A·B') }], ['A', 'B']);
    if ('error' in sim || 'error' in mine) throw new Error('table');
    expect(mine.rows.map((r) => [r.inputs, r.outputs])).toEqual(sim.rows.map((r) => [r.inputs, r.outputs]));
  });
});
