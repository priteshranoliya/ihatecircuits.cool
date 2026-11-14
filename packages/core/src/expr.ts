import type { Cell, Column, TruthTable } from './analysis';

/**
 * Boolean expressions: parsing, printing and evaluation.
 *
 * Accepted notations (freely mixable):
 *   NOT  postfix  A'  A′      prefix  ~A  !A  ¬A  NOT A
 *   AND  A·B  A*B  A&B  A&&B  A∧B  A AND B   and, when every variable is a
 *        single letter, plain juxtaposition: AB, A'B, A(B+C), (A+B)(C+D)
 *   XOR  A^B  A⊕B  A XOR B
 *   OR   A+B  A|B  A||B  A∨B  A OR B
 *   constants 0 and 1, parentheses.
 * Precedence, high to low: NOT, AND, XOR, OR. Word operators ignore case.
 * Variable names are a letter followed by letters, digits or underscores.
 *
 * Juxtaposition is read as AND only in "single-letter mode". The mode is
 * chosen from `opts.names` when given (every name one letter long), otherwise
 * from the text: every name must be letters only and written in one case (AB,
 * ab). Then a run such as ABC means A·B·C. A name like Cin, B1 or D_0 turns
 * the mode off, and an operator is then required between operands.
 */

export type AST =
  | { k: 'const'; v: 0 | 1 }
  | { k: 'var'; name: string }
  | { k: 'not'; a: AST }
  | { k: 'and' | 'or' | 'xor'; args: AST[] };

export interface ParseError {
  message: string;
  /** Zero-based character offset in the input where the problem was noticed. */
  index: number;
}

export type ParseResult = { ast: AST } | { error: ParseError };

// ---------------------------------------------------------------- constructors

export const mkConst = (v: 0 | 1): AST => ({ k: 'const', v });
export const mkVar = (name: string): AST => ({ k: 'var', name });
export const mkNot = (a: AST): AST => ({ k: 'not', a });

function mkOp(k: 'and' | 'or' | 'xor', args: AST[]): AST {
  const flat: AST[] = [];
  for (const a of args) {
    if (a.k === k) flat.push(...a.args);
    else flat.push(a);
  }
  if (flat.length === 0) return mkConst(k === 'and' ? 1 : 0);
  if (flat.length === 1) return flat[0];
  return { k, args: flat };
}
/** n-ary AND/OR/XOR. Nested nodes of the same kind are merged; one operand is returned as is; none gives the identity constant. */
export const mkAnd = (...args: AST[]): AST => mkOp('and', args);
export const mkOr = (...args: AST[]): AST => mkOp('or', args);
export const mkXor = (...args: AST[]): AST => mkOp('xor', args);

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { t: 'var'; name: string; i: number }
  | { t: 'const'; v: 0 | 1; i: number }
  | { t: 'not' | 'and' | 'or' | 'xor' | 'lp' | 'rp' | 'post'; i: number }
  | { t: 'end'; i: number };

class Fail extends Error {
  constructor(
    public msg: string,
    public index: number,
  ) {
    super(msg);
  }
}

const WORDS: Record<string, 'not' | 'and' | 'or' | 'xor'> = { not: 'not', and: 'and', or: 'or', xor: 'xor' };

function lex(text: string, opts: { names?: readonly string[] }): Tok[] {
  type Raw = { t: 'id'; name: string; i: number } | Tok;
  const raw: Raw[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const op = WORDS[word.toLowerCase()];
      raw.push(op ? ({ t: op, i } as Tok) : { t: 'id', name: word, i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[0-9A-Za-z_]/.test(text[j])) j++;
      const lit = text.slice(i, j);
      if (lit !== '0' && lit !== '1') {
        throw new Fail(/^[0-9]+$/.test(lit) ? `Only 0 and 1 can be used as constants, not "${lit}" (position ${i + 1})` : `A name must start with a letter, not "${lit}" (position ${i + 1})`, i);
      }
      raw.push({ t: 'const', v: lit === '1' ? 1 : 0, i });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '&&') raw.push({ t: 'and', i }), (i += 2);
    else if (two === '||') raw.push({ t: 'or', i }), (i += 2);
    else if ("'′".includes(ch)) raw.push({ t: 'post', i }), i++;
    else if ('~!¬'.includes(ch)) raw.push({ t: 'not', i }), i++;
    else if ('·*&∧'.includes(ch)) raw.push({ t: 'and', i }), i++;
    else if ('+|∨'.includes(ch)) raw.push({ t: 'or', i }), i++;
    else if ('^⊕'.includes(ch)) raw.push({ t: 'xor', i }), i++;
    else if (ch === '(') raw.push({ t: 'lp', i }), i++;
    else if (ch === ')') raw.push({ t: 'rp', i }), i++;
    else throw new Fail(`Unexpected character "${ch}" at position ${i + 1}`, i);
  }

  const ids = raw.filter((r): r is Extract<Raw, { t: 'id' }> => r.t === 'id');
  const single = opts.names ? opts.names.every((n) => n.length === 1) : ids.every((r) => /^[A-Z]+$|^[a-z]+$/.test(r.name));

  const out: Tok[] = [];
  for (const r of raw) {
    if (r.t !== 'id') out.push(r);
    else if (single) [...r.name].forEach((c, k) => out.push({ t: 'var', name: c, i: r.i + k }));
    else out.push({ t: 'var', name: r.name, i: r.i });
  }
  out.push({ t: 'end', i: text.length });
  return out;
}

// ---------------------------------------------------------------- parser

const describe = (tok: Tok, text: string): string => {
  switch (tok.t) {
    case 'end':
      return 'the end of the expression';
    case 'var':
      return `"${tok.name}"`;
    case 'const':
      return `"${tok.v}"`;
    case 'rp':
      return 'a closing parenthesis';
    case 'lp':
      return 'an opening parenthesis';
    default:
      return `"${text[tok.i]}"`;
  }
};

/** Parse an expression. Never throws: problems come back as `{ error: { message, index } }`. */
export function parse(text: string, opts: { names?: readonly string[] } = {}): ParseResult {
  try {
    if (text.trim() === '') throw new Fail('Type an expression, for example A·B′ + C', 0);
    const toks = lex(text, opts);
    const single = (() => {
      // Juxtaposition is allowed exactly when the lexer split letters apart or every name is one letter.
      const vars = toks.filter((t): t is Extract<Tok, { t: 'var' }> => t.t === 'var');
      return vars.every((v) => v.name.length === 1);
    })();
    let p = 0;
    const peek = () => toks[p];
    const startsOperand = (t: Tok) => t.t === 'var' || t.t === 'const' || t.t === 'lp' || t.t === 'not';

    function parseOr(): AST {
      const args = [parseXor()];
      while (peek().t === 'or') {
        p++;
        args.push(parseXor());
      }
      return mkOr(...args);
    }
    function parseXor(): AST {
      const args = [parseAnd()];
      while (peek().t === 'xor') {
        p++;
        args.push(parseAnd());
      }
      return mkXor(...args);
    }
    function parseAnd(): AST {
      const args = [parseUnary()];
      for (;;) {
        const t = peek();
        if (t.t === 'and') {
          p++;
          args.push(parseUnary());
        } else if (startsOperand(t)) {
          if (!single) {
            const prev = toks[p - 1];
            throw new Fail(`Expected an operator (AND, OR, XOR) before ${describe(t, text)} at position ${t.i + 1}${prev ? `, after ${describe(prev, text)}` : ''}`, t.i);
          }
          args.push(parseUnary());
        } else break;
      }
      return mkAnd(...args);
    }
    function parseUnary(): AST {
      const t = peek();
      if (t.t === 'not') {
        p++;
        return mkNot(parseUnary());
      }
      let a = parsePrimary();
      while (peek().t === 'post') {
        p++;
        a = mkNot(a);
      }
      return a;
    }
    function parsePrimary(): AST {
      const t = toks[p];
      if (t.t === 'var') {
        p++;
        return mkVar(t.name);
      }
      if (t.t === 'const') {
        p++;
        return mkConst(t.v);
      }
      if (t.t === 'lp') {
        p++;
        if (peek().t === 'rp') throw new Fail(`Empty parentheses at position ${t.i + 1}: put an expression inside`, t.i);
        const inner = parseOr();
        const close = peek();
        if (close.t !== 'rp') {
          if (close.t === 'end') throw new Fail(`Expected a closing parenthesis after position ${text.length}`, text.length);
          throw new Fail(`Expected a closing parenthesis at position ${close.i + 1}, found ${describe(close, text)}`, close.i);
        }
        p++;
        return inner;
      }
      if (t.t === 'rp') throw new Fail(`Unexpected closing parenthesis at position ${t.i + 1}: there is no matching opening parenthesis`, t.i);
      if (t.t === 'end') throw new Fail(`The expression ends too early: expected a variable, 0, 1 or an opening parenthesis after position ${text.length}`, text.length);
      if (t.t === 'post') throw new Fail(`A ′ at position ${t.i + 1} must follow a variable or a closing parenthesis`, t.i);
      throw new Fail(`Expected a variable, 0, 1 or an opening parenthesis at position ${t.i + 1}, found ${describe(t, text)}`, t.i);
    }

    const ast = parseOr();
    const rest = peek();
    if (rest.t !== 'end') {
      if (rest.t === 'rp') throw new Fail(`Unexpected closing parenthesis at position ${rest.i + 1}: there is no matching opening parenthesis`, rest.i);
      throw new Fail(`Unexpected ${describe(rest, text)} at position ${rest.i + 1}`, rest.i);
    }
    return { ast };
  } catch (e) {
    if (e instanceof Fail) return { error: { message: e.msg, index: e.index } };
    throw e;
  }
}

// ---------------------------------------------------------------- queries

/** Variable names in order of first appearance. */
export function variables(ast: AST): string[] {
  const seen: string[] = [];
  const walk = (a: AST) => {
    if (a.k === 'var') {
      if (!seen.includes(a.name)) seen.push(a.name);
    } else if (a.k === 'not') walk(a.a);
    else if (a.k !== 'const') a.args.forEach(walk);
  };
  walk(ast);
  return seen;
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Natural ordering of names: A, B, B2, B10, Cin. Returns a new array. */
export const sortVariables = (names: readonly string[]): string[] => [...names].sort((a, b) => natural.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));

export type Assignment = Readonly<Record<string, boolean | number>>;

/** Value of the expression. Every variable must be assigned; an unassigned one throws (a programming error, not user input). */
export function evaluate(ast: AST, assignment: Assignment): 0 | 1 {
  switch (ast.k) {
    case 'const':
      return ast.v;
    case 'var': {
      const v = assignment[ast.name];
      if (v === undefined) throw new Error(`Variable ${ast.name} has no value`);
      return v ? 1 : 0;
    }
    case 'not':
      return evaluate(ast.a, assignment) ? 0 : 1;
    case 'and':
      return ast.args.every((a) => evaluate(a, assignment)) ? 1 : 0;
    case 'or':
      return ast.args.some((a) => evaluate(a, assignment)) ? 1 : 0;
    case 'xor':
      return ast.args.reduce<number>((acc, a) => acc ^ evaluate(a, assignment), 0) as 0 | 1;
  }
}

/** Assignment for row r: the first input is the most significant bit. */
export function rowAssignment(inputs: readonly string[], r: number): Record<string, 0 | 1> {
  const n = inputs.length;
  const out: Record<string, 0 | 1> = {};
  inputs.forEach((name, k) => (out[name] = ((r >> (n - 1 - k)) & 1) as 0 | 1));
  return out;
}

export const MAX_EXPR_INPUTS = 12;

/**
 * Truth table of named expressions over the given inputs, in the same shape
 * analysis.ts produces (row r's inputs spell r, first input = MSB).
 * Returns an error object for an expression using a variable that is not in `inputs`, or too many inputs.
 */
export function toTruthTable(exprs: readonly { name: string; ast: AST }[], inputs: readonly string[]): TruthTable | { error: string } {
  if (inputs.length === 0) return { error: 'There are no input variables.' };
  if (inputs.length > MAX_EXPR_INPUTS) return { error: `A truth table can have at most ${MAX_EXPR_INPUTS} inputs, not ${inputs.length}.` };
  for (const e of exprs) {
    const missing = variables(e.ast).filter((v) => !inputs.includes(v));
    if (missing.length) return { error: `${e.name} uses ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the input list.` };
  }
  const col = (name: string): Column => ({ id: name, pin: 'p', bit: 0, name });
  const n = inputs.length;
  const rows: TruthTable['rows'] = [];
  for (let r = 0; r < 1 << n; r++) {
    const asg = rowAssignment(inputs, r);
    rows.push({
      inputs: inputs.map((name) => asg[name]),
      outputs: exprs.map((e): Cell => evaluate(e.ast, asg)),
      oscillates: false,
    });
  }
  return { inputs: inputs.map(col), outputs: exprs.map((e) => col(e.name)), rows, hasMemory: false };
}

/** Structural equality. */
export function equalAst(a: AST, b: AST): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'const':
      return a.v === (b as typeof a).v;
    case 'var':
      return a.name === (b as typeof a).name;
    case 'not':
      return equalAst(a.a, (b as typeof a).a);
    default: {
      const o = b as typeof a;
      return a.args.length === o.args.length && a.args.every((x, i) => equalAst(x, o.args[i]));
    }
  }
}

// ---------------------------------------------------------------- printing

export type FormatStyle = 'math' | 'logic' | 'code' | 'bits';

interface Syntax {
  not: (s: string, atom: boolean) => string;
  and: string;
  or: string;
  xor: string;
}
const STYLES: Record<FormatStyle, Syntax> = {
  math: { not: (s, atom) => (atom ? `${s}′` : `(${s})′`), and: '·', or: ' + ', xor: ' ⊕ ' },
  logic: { not: (s, atom) => (atom ? `¬${s}` : `¬(${s})`), and: ' ∧ ', or: ' ∨ ', xor: ' ⊕ ' },
  code: { not: (s, atom) => (atom ? `!${s}` : `!(${s})`), and: ' && ', or: ' || ', xor: ' ^ ' },
  bits: { not: (s, atom) => (atom ? `~${s}` : `~(${s})`), and: ' & ', or: ' | ', xor: ' ^ ' },
};

const PREC = { or: 1, xor: 2, and: 3 } as const;

/**
 * Print with the fewest parentheses that keep the meaning.
 *   math  A·B′ + C        logic  A ∧ ¬B ∨ C
 *   code  A && !B || C    bits   A & ~B | C
 * Output parses back to the same expression (up to merging nested same-kind operators).
 */
export function format(ast: AST, style: FormatStyle = 'math'): string {
  const syn = STYLES[style];
  const go = (a: AST): string => {
    switch (a.k) {
      case 'const':
        return String(a.v);
      case 'var':
        return a.name;
      case 'not': {
        const atom = a.a.k === 'var' || a.a.k === 'const' || a.a.k === 'not';
        return syn.not(go(a.a), atom);
      }
      default: {
        const p = PREC[a.k];
        const sep = a.k === 'and' ? syn.and : a.k === 'or' ? syn.or : syn.xor;
        return a.args.map((x) => ((x.k === 'and' || x.k === 'or' || x.k === 'xor') && PREC[x.k] < p ? `(${go(x)})` : go(x))).join(sep);
      }
    }
  };
  return go(ast);
}
