import type {
  AlwaysBlock,
  AssignStmt,
  Attribute,
  Attributed,
  BlockDecl,
  CaseItem,
  CellRef,
  ChargeStrength,
  ConcatExpr,
  ConfigDecl,
  ConfigRule,
  Connection,
  DelayList,
  Declarator,
  DriveStrength,
  EventControl,
  EventTerm,
  Expr,
  FunctionDecl,
  GateInst,
  GateKind,
  GenerateCase,
  GenerateFor,
  GenerateRegion,
  GenvarDecl,
  DefparamItem,
  InitialBlock,
  SpecifyBlock,
  GenerateBlock,
  GenerateCaseItem,
  HierSegment,
  Ident,
  IndexExpr,
  Instance,
  LoopAssign,
  ModuleDecl,
  ModuleItem,
  NamedParamValue,
  NetDecl,
  NetKind,
  NonAnsiPort,
  OrderedConnection,
  ParamAssign,
  ParamDecl,
  ParamOverrides,
  PathDecl,
  PortDecl,
  PortDeclItem,
  PortRef,
  PulseStyleDecl,
  RangeSpec,
  Ref,
  SourceFile,
  SourceUnit,
  SpecifyItem,
  SpecparamDecl,
  Stmt,
  Strength0,
  Strength1,
  TaskDecl,
  TfPort,
  TimingArg,
  TimingCheck,
  TimingControl,
  UdpDecl,
  UdpEntry,
  UdpPort,
  UdpPortDecl,
} from './ast';
import { type DiagnosticCode, type DiagnosticSink, type Span, abbreviate, joinSpans } from './diagnostics';
import type { Token } from './lexer';

/**
 * Recursive-descent parser with a Pratt expression parser, for the whole of IEEE 1364-2005 annex A.
 *
 * Error recovery. A syntax error is reported once, then the parser abandons the construct it was in and skips
 * to a safe point: the end of the statement inside a begin/end block, the end of the item inside a module,
 * generate block, function or specify block. Two unrelated mistakes therefore give two diagnostics. The skip
 * follows `begin`/`end` and the other paired keywords, so it does not stop in the middle of a nested block and
 * leave the rest of it to be reported again.
 */

class Abort extends Error {}
const ABORT = new Abort();
/** Thrown past every recovery point inside a module: the rest of the module is skipped, as its structure can no longer be followed. */
class AbortModule extends Error {}
const ABORT_MODULE = new AbortModule();

/** Binding power of binary operators, loosest first (IEEE 1364-2005 table 5-4). */
const BINARY_BP: Record<string, number> = {
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '~^': 5,
  '^~': 5,
  '&': 6,
  '==': 7,
  '!=': 7,
  '===': 7,
  '!==': 7,
  '<': 8,
  '<=': 8,
  '>': 8,
  '>=': 8,
  '<<': 9,
  '>>': 9,
  '<<<': 9,
  '>>>': 9,
  '+': 10,
  '-': 10,
  '*': 11,
  '/': 11,
  '%': 11,
  '**': 12,
};
const TERNARY_BP = 1;
/** Deepest nesting of expressions or statements the parser follows before it gives up with a diagnostic. */
const MAX_DEPTH = 500;
const UNARY_OPS = new Set(['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^', '^~']);

const NET_TYPES = new Set<string>(['wire', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor', 'supply0', 'supply1', 'uwire']);
const VAR_TYPES = new Set<string>(['reg', 'integer', 'real', 'realtime', 'time', 'event']);
const GATES = new Set<string>(['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'buf', 'not', 'bufif0', 'bufif1', 'notif0', 'notif1', 'nmos', 'pmos', 'rnmos', 'rpmos', 'cmos', 'rcmos', 'tran', 'rtran', 'tranif0', 'tranif1', 'rtranif0', 'rtranif1', 'pullup', 'pulldown']);
const STRENGTH0 = new Set<string>(['supply0', 'strong0', 'pull0', 'weak0', 'highz0']);
const STRENGTH1 = new Set<string>(['supply1', 'strong1', 'pull1', 'weak1', 'highz1']);
const CHARGE = new Set<string>(['small', 'medium', 'large']);
const ITEM_START = new Set<string>([
  ...NET_TYPES,
  ...VAR_TYPES,
  ...GATES,
  'assign', 'always', 'initial', 'input', 'output', 'inout', 'parameter', 'localparam', 'specparam', 'genvar', 'generate', 'function', 'task', 'defparam', 'specify', 'endgenerate', 'endfunction', 'endtask', 'endspecify',
]);
const OPENERS = new Set(['begin', 'fork', 'case', 'casex', 'casez', 'function', 'task', 'generate', 'specify', 'table']);
const CLOSER_FOR: Record<string, string> = { end: 'begin', join: 'fork', endcase: 'case', endfunction: 'function', endtask: 'task', endgenerate: 'generate', endspecify: 'specify', endtable: 'table' };
const TOP_START = new Set(['module', 'macromodule', 'primitive', 'config']);
const TIMING_CHECKS = new Set(['$setup', '$hold', '$setuphold', '$recovery', '$removal', '$recrem', '$skew', '$timeskew', '$fullskew', '$period', '$width', '$nochange']);

type SpecPulse = PulseStyleDecl['style'];

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly toks: Token[],
    private readonly sink: DiagnosticSink,
  ) {}

  // ------------------------------------------------------------ token helpers

  private peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  private get eof() {
    return this.peek().kind === 'eof';
  }
  private isOp(text: string, k = 0) {
    const t = this.peek(k);
    return t.kind === 'op' && t.text === text;
  }
  private isKw(text: string, k = 0) {
    const t = this.peek(k);
    return t.kind === 'keyword' && t.text === text;
  }
  private eatOp(text: string): Token | undefined {
    return this.isOp(text) ? this.next() : undefined;
  }
  private eatKw(text: string): Token | undefined {
    return this.isKw(text) ? this.next() : undefined;
  }
  private kwIn(set: ReadonlySet<string>, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'keyword' && set.has(t.text);
  }

  private describe(t: Token): string {
    return t.kind === 'eof' ? 'the end of the file' : `'${abbreviate(t.text)}'`;
  }

  private lastErrorPos = -1;
  private lexErrors: Span[] | undefined;

  /**
   * Report a syntax error, unless it only follows from an earlier one: a second error at the same token, or an
   * error right after a lexer or preprocessor error that already says what went wrong there.
   */
  private report(code: DiagnosticCode, message: string, span: Span) {
    if (this.pos === this.lastErrorPos) return;
    this.lexErrors ??= this.sink.items.filter((d) => d.code === 'lex-error' || d.code === 'preprocess-error').map((d) => d.span);
    const prev = this.toks[Math.max(0, this.pos - 1)]!.span;
    const cur = this.peek().span;
    if (this.lexErrors.some((l) => l.start >= prev.start && l.end <= cur.start)) return;
    this.lastErrorPos = this.pos;
    this.sink.error(code, message, span);
  }

  private fail(span: Span, message: string, code: DiagnosticCode = 'syntax-error'): never {
    this.report(code, message, span);
    throw ABORT;
  }

  private expectOp(text: string, context: string): Token {
    const t = this.peek();
    if (t.kind === 'op' && t.text === text) return this.next();
    return this.fail(t.span, `Expected '${text}' ${context}, but found ${this.describe(t)}.`);
  }
  private expectKw(text: string, context: string): Token {
    const t = this.peek();
    if (t.kind === 'keyword' && t.text === text) return this.next();
    return this.fail(t.span, `Expected '${text}' ${context}, but found ${this.describe(t)}.`);
  }
  private expectIdent(context: string): Ident {
    const t = this.peek();
    if (t.kind === 'ident') {
      this.next();
      return { kind: 'ident', name: t.text, span: t.span };
    }
    return this.fail(t.span, `Expected a name ${context}, but found ${this.describe(t)}.`);
  }

  private since(start: Span): Span {
    return joinSpans(start, this.toks[Math.max(0, this.pos - 1)]!.span);
  }

  private withAttrs<T extends Attributed>(node: T, attrs: Attribute[] | undefined): T {
    if (attrs && attrs.length > 0) node.attrs = attrs;
    return node;
  }

  // ------------------------------------------------------------ recovery

  /**
   * Skip to the end of the construct the parser was in: past the next ';' outside brackets and blocks, or up to
   * a token that cannot belong to it. `items` also stops at a keyword that starts a module item.
   */
  private skipConstruct(items: boolean) {
    let parens = 0;
    const open: string[] = [];
    while (!this.eof) {
      const t = this.peek();
      if (t.kind === 'keyword') {
        if (t.text === 'endmodule' || TOP_START.has(t.text) || t.text === 'endprimitive' || t.text === 'endconfig') return;
        if (items && parens === 0 && open.length === 0 && ITEM_START.has(t.text) && !(t.text in CLOSER_FOR)) return;
        if (OPENERS.has(t.text)) open.push(t.text);
        else if (t.text in CLOSER_FOR) {
          if (open.length === 0) return;
          const want = CLOSER_FOR[t.text]!;
          while (open.length > 0 && open[open.length - 1] !== want) open.pop();
          open.pop();
          this.next();
          if (open.length === 0 && parens === 0 && !this.isKw('else')) return;
          continue;
        } else if (t.text === 'else' && open.length === 0 && !items) return;
      } else if (t.kind === 'op') {
        if (t.text === ';' && parens === 0 && open.length === 0) {
          this.next();
          return;
        }
        if (t.text === '(' || t.text === '[' || t.text === '{') parens++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') parens = Math.max(0, parens - 1);
      }
      this.next();
    }
  }
  private syncItem() {
    this.skipConstruct(true);
  }
  private syncStatement() {
    this.skipConstruct(false);
  }

  /** Skip tokens up to and including the keyword `end`. */
  private skipThrough(endKeyword: string) {
    while (!this.eof && !this.isKw(endKeyword)) {
      if (this.isKw('endmodule') || (endKeyword !== 'endmodule' && TOP_START.has(this.peek().text) && this.peek().kind === 'keyword')) return;
      this.next();
    }
    this.eatKw(endKeyword);
  }

  // ------------------------------------------------------------ attributes

  private parseAttrs(): Attribute[] | undefined {
    if (!this.isOp('(*')) return undefined;
    const attrs: Attribute[] = [];
    while (this.isOp('(*')) {
      const open = this.next();
      if (this.isOp('*)')) {
        this.next();
        continue;
      }
      for (;;) {
        const name = this.expectIdent("for the attribute (write '(* name *)' or '(* name = value *)')");
        let value: Expr | undefined;
        if (this.eatOp('=')) value = this.parseExpr(0);
        attrs.push({ name, value, span: this.since(name.span) });
        if (!this.eatOp(',')) break;
      }
      if (!this.eatOp('*)')) {
        const t = this.peek();
        this.fail(t.span, `Expected '*)' to close the attribute that starts at line ${open.span.line}, but found ${this.describe(t)}.`);
      }
    }
    return attrs;
  }

  // ------------------------------------------------------------ expressions

  /** Count one level of nesting; a pathological input gets a diagnostic here instead of exhausting the stack. */
  private nested<T>(what: string, f: () => T): T {
    if (this.depth >= MAX_DEPTH) {
      this.sink.error('too-deep', `${what} nested more than ${MAX_DEPTH} levels deep, which the compiler does not support. Split it into smaller parts.`, this.peek().span);
      throw ABORT_MODULE;
    }
    this.depth++;
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  parseExpr(minBp = 0): Expr {
    return this.nested('This expression is', () => this.parseExprBody(minBp));
  }

  /** `expr` or `min : typ : max`. */
  private parseMinTypMax(): Expr {
    const min = this.parseExpr(0);
    if (!this.isOp(':')) return min;
    this.next();
    const typ = this.parseExpr(0);
    this.expectOp(':', "after the typical value in 'min : typ : max'");
    const max = this.parseExpr(0);
    return { kind: 'mintypmax', min, typ, max, span: joinSpans(min.span, max.span) };
  }

  private parseExprBody(minBp: number): Expr {
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      if (t.text === '?') {
        if (TERNARY_BP < minBp) break;
        this.next();
        const attrs = this.parseAttrs();
        const then = this.parseExpr(0);
        this.expectOp(':', "in the '?:' expression");
        const other = this.parseExpr(TERNARY_BP);
        lhs = this.withAttrs({ kind: 'ternary', cond: lhs, then, else: other, span: joinSpans(lhs.span, other.span) } as Expr & Attributed, attrs);
        continue;
      }
      const bp = BINARY_BP[t.text];
      if (bp === undefined || bp < minBp) break;
      this.next();
      const attrs = this.parseAttrs();
      const rhs = this.parseExpr(bp + 1);
      lhs = this.withAttrs({ kind: 'binary', op: t.text, lhs, rhs, span: joinSpans(lhs.span, rhs.span) } as Expr & Attributed, attrs);
    }
    return lhs;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && UNARY_OPS.has(t.text)) {
      this.next();
      const attrs = this.parseAttrs();
      const again = this.peek();
      if (again.kind === 'op' && UNARY_OPS.has(again.text)) {
        return this.fail(again.span, `The operand of a unary operator must be a primary (IEEE 1364-2005 section 5.1.5), not another operator. Write ${t.text}(${again.text}x) with parentheses.`);
      }
      const operand = this.parsePrimary();
      return this.withAttrs({ kind: 'unary', op: t.text, operand, span: joinSpans(t.span, operand.span) } as Expr & Attributed, attrs);
    }
    return this.parsePrimary();
  }

  private isRealLiteral(text: string): boolean {
    return !text.includes("'") && /[.eE]/.test(text);
  }

  /** An operand: literal, name with optional select or call, parenthesised expression, or concatenation. */
  parsePrimary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'number':
        this.next();
        return this.isRealLiteral(t.text) ? { kind: 'real', text: t.text, span: t.span } : { kind: 'number', text: t.text, span: t.span };
      case 'ident':
        return this.parseReference(true);
      case 'system': {
        this.next();
        const args: Expr[] = [];
        let parens = false;
        if (this.isOp('(')) {
          parens = true;
          this.next();
          if (!this.isOp(')')) {
            for (;;) {
              args.push(this.parseExpr(0));
              if (!this.eatOp(',')) break;
            }
          }
          this.expectOp(')', `to close the call of ${t.text}`);
        }
        return { kind: 'syscall', name: t.text, args, parens, span: this.since(t.span) };
      }
      case 'string':
        this.next();
        return { kind: 'string', text: t.text, span: t.span };
      case 'op':
        if (t.text === '(') {
          this.next();
          const inner = this.parseMinTypMax();
          this.expectOp(')', 'to close the parenthesis');
          return inner;
        }
        if (t.text === '{') return this.parseConcat();
        break;
      default:
    }
    return this.fail(t.span, `Expected an expression, but found ${this.describe(t)}.`);
  }

  /** One `[...]` select: a bit, a range, or an indexed part select. */
  private parseSelect(): { hi: Expr; lo?: Expr; mode: IndexExpr['mode']; close: Token } {
    this.next();
    const hi = this.parseExpr(0);
    let mode: IndexExpr['mode'] = 'bit';
    let lo: Expr | undefined;
    if (this.eatOp(':')) {
      mode = 'range';
      lo = this.parseExpr(0);
    } else if (this.eatOp('+:')) {
      mode = 'plus';
      lo = this.parseExpr(0);
    } else if (this.eatOp('-:')) {
      mode = 'minus';
      lo = this.parseExpr(0);
    }
    const close = this.expectOp(']', "to close the '['");
    return { hi, lo, mode, close };
  }

  /**
   * A name, possibly hierarchical (`a.b[2].c`), with its selects (`[i][j][7:4]`), or a call of a function.
   * With `selects` false a bare name is read, as for the target of a call or of `disable`.
   */
  private parseReference(selects: boolean): Expr {
    const first = this.next();
    const segments: HierSegment[] = [{ name: { kind: 'ident', name: first.text, span: first.span } }];
    const sels: { hi: Expr; lo?: Expr; mode: IndexExpr['mode']; close: Token }[] = [];
    for (;;) {
      if (selects) {
        while (this.isOp('[')) sels.push(this.parseSelect());
      }
      if (this.isOp('.') && this.peek(1).kind === 'ident') {
        if (sels.length > 1 || (sels.length === 1 && sels[0]!.mode !== 'bit')) {
          this.fail(this.peek().span, 'Only one index can select a scope of a generate array in a hierarchical name, as in g[2].x.');
        }
        if (sels.length === 1) {
          segments[segments.length - 1]!.index = sels[0]!.hi;
          sels.length = 0;
        }
        this.next();
        const seg = this.next();
        segments.push({ name: { kind: 'ident', name: seg.text, span: seg.span } });
        continue;
      }
      break;
    }
    const last = segments[segments.length - 1]!.name;
    const ref: Ref =
      segments.length === 1
        ? segments[0]!.name
        : { kind: 'hier', segments, name: segments.map((s) => s.name.name).join('.'), span: joinSpans(segments[0]!.name.span, last.span) };
    if (sels.length > 0) {
      const fin = sels[sels.length - 1]!;
      for (const s of sels.slice(0, -1)) {
        if (s.mode !== 'bit') this.fail(s.hi.span, 'Only the last select of a name can be a part select. Earlier ones must be single indexes.');
      }
      return { kind: 'index', base: ref, dims: sels.slice(0, -1).map((s) => s.hi), hi: fin.hi, lo: fin.lo, mode: fin.mode, span: joinSpans(ref.span, fin.close.span) };
    }
    if (selects && (this.isOp('(') || (this.isOp('(*') && this.attrsThenParen()))) return this.parseCall(ref);
    return ref;
  }

  /** Whether the attribute list starting here is followed by '(', as in `f (* a *) (x)`. */
  private attrsThenParen(): boolean {
    let k = 0;
    while (this.peek(k).kind !== 'eof' && !(this.peek(k).kind === 'op' && this.peek(k).text === '*)')) k++;
    return this.isOp('(', k + 1);
  }

  private parseCall(callee: Ref): Expr {
    // `f (* attr *) (args)`: the attribute sits between the name and the arguments.
    const attrs = this.parseAttrs();
    this.next();
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.parseExpr(0));
        if (!this.eatOp(',')) break;
      }
    }
    const close = this.expectOp(')', `to close the call of '${callee.name}'`);
    return this.withAttrs({ kind: 'call', callee, args, span: joinSpans(callee.span, close.span) } as Expr & Attributed, attrs);
  }

  private parseConcat(): Expr {
    const open = this.next();
    const first = this.parseConcatPart();
    if (first.kind === 'replicate' && this.isOp('}')) {
      // `{n{...}}`: the braces around the replication are the ones just opened.
      const close = this.next();
      return { ...first, span: joinSpans(open.span, close.span) };
    }
    const parts = [first];
    while (this.eatOp(',')) parts.push(this.parseConcatPart());
    const close = this.expectOp('}', "to close the concatenation '{'");
    return { kind: 'concat', parts, span: joinSpans(open.span, close.span) };
  }

  /** One element of a concatenation: an expression, or a replication `n{...}`. */
  private parseConcatPart(): Expr {
    const e = this.parseExpr(0);
    if (!this.isOp('{')) return e;
    const body = this.parseConcat();
    const inner: ConcatExpr = body.kind === 'concat' ? body : { kind: 'concat', parts: [body], span: body.span };
    return { kind: 'replicate', count: e, inner, span: joinSpans(e.span, this.toks[this.pos - 1]!.span) };
  }

  // ------------------------------------------------------------ delays and events

  private parseRange(): RangeSpec {
    const open = this.expectOp('[', 'to start the range');
    const msb = this.parseExpr(0);
    this.expectOp(':', 'between the two range bounds');
    const lsb = this.parseExpr(0);
    const close = this.expectOp(']', 'to close the range');
    return { msb, lsb, span: joinSpans(open.span, close.span) };
  }

  /** After `#`: a number, a name, or a parenthesised list of one or more mintypmax values. */
  private parseDelay(): DelayList {
    const hash = this.expectOp('#', 'to start the delay');
    const t = this.peek();
    if (t.kind === 'op' && t.text === '(') {
      this.next();
      const values: Expr[] = [];
      for (;;) {
        values.push(this.parseMinTypMax());
        if (!this.eatOp(',')) break;
      }
      this.expectOp(')', 'to close the delay');
      return { values, span: this.since(hash.span) };
    }
    if (t.kind === 'number') {
      this.next();
      return { values: [this.isRealLiteral(t.text) ? { kind: 'real', text: t.text, span: t.span } : { kind: 'number', text: t.text, span: t.span }], span: this.since(hash.span) };
    }
    if (t.kind === 'ident') {
      return { values: [this.parseReference(false)], span: this.since(hash.span) };
    }
    return this.fail(t.span, `Expected a delay value (a number, a name, or '(...)') after '#', but found ${this.describe(t)}.`);
  }

  private parseEventControl(): EventControl {
    const at = this.expectOp('@', 'to start the event control');
    if (this.eatOp('*')) return { kind: 'event', events: 'star', span: this.since(at.span) };
    if (this.isOp('(')) {
      this.next();
      if (this.isOp('*') && this.isOp(')', 1)) {
        this.next();
        this.next();
        return { kind: 'event', events: 'star', span: this.since(at.span) };
      }
      if (this.isOp('*)')) {
        this.next();
        return { kind: 'event', events: 'star', span: this.since(at.span) };
      }
      const terms: EventTerm[] = [];
      for (;;) {
        let edge: EventTerm['edge'] = 'level';
        if (this.eatKw('posedge')) edge = 'pos';
        else if (this.eatKw('negedge')) edge = 'neg';
        terms.push({ edge, expr: this.parseExpr(0) });
        if (this.eatKw('or') || this.eatOp(',')) continue;
        break;
      }
      this.expectOp(')', `to close the event list that starts at line ${at.span.line}`);
      return { kind: 'event', events: terms, span: this.since(at.span) };
    }
    const t = this.peek();
    if (t.kind === 'ident') {
      const e = this.parseReference(true);
      return { kind: 'event', events: [{ edge: 'level', expr: e }], span: this.since(at.span) };
    }
    return this.fail(t.span, `Expected '(', '*' or an event name after '@', but found ${this.describe(t)}.`);
  }

  // ------------------------------------------------------------ statements

  private parseStatement(): Stmt {
    return this.nested('These statements are', () => this.parseStatementBody());
  }

  private parseLvalue(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '{') return this.parseConcat();
    if (t.kind === 'ident') return this.parseReference(true);
    return this.fail(t.span, `Expected the target of an assignment, but found ${this.describe(t)}.`);
  }

  /** After `=` or `<=`: an optional intra-assignment delay or event control. */
  private parseIntraControl(): TimingControl | undefined {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '#') {
      const delay = this.parseDelay();
      return { kind: 'delay', delay, span: delay.span };
    }
    if (t.kind === 'op' && t.text === '@') return this.parseEventControl();
    if (t.kind === 'keyword' && t.text === 'repeat') {
      this.next();
      this.expectOp('(', "after 'repeat'");
      const count = this.parseExpr(0);
      this.expectOp(')', "after the repeat count");
      const event = this.parseEventControl();
      return { kind: 'repeatEvent', count, event, span: this.since(t.span) };
    }
    return undefined;
  }

  private parseLoopAssign(): LoopAssign {
    const lhs = this.parseLvalue();
    this.expectOp('=', 'after the assignment target');
    const rhs = this.parseExpr(0);
    return { lhs, rhs, span: joinSpans(lhs.span, rhs.span) };
  }

  private parseStatementBody(): Stmt {
    const attrs = this.parseAttrs();
    const t = this.peek();
    const done = <T extends Stmt>(s: T): T => this.withAttrs(s, attrs);
    if (t.kind === 'op') {
      switch (t.text) {
        case ';':
          this.next();
          return done({ kind: 'empty', span: t.span });
        case '#': {
          const delay = this.parseDelay();
          const body = this.parseStatement();
          return done({ kind: 'timing', control: { kind: 'delay', delay, span: delay.span }, body, span: this.since(t.span) });
        }
        case '@': {
          const control = this.parseEventControl();
          const body = this.parseStatement();
          return done({ kind: 'timing', control, body, span: this.since(t.span) });
        }
        case '->': {
          this.next();
          const event = this.parseReference(true);
          this.expectOp(';', "after the event trigger");
          return done({ kind: 'trigger', event, span: this.since(t.span) });
        }
        case '{':
          return done(this.parseAssignment(t));
        default:
          return this.fail(t.span, `Expected a statement, but found ${this.describe(t)}.`);
      }
    }
    if (t.kind === 'system') {
      this.next();
      const args: (Expr | null)[] = [];
      let parens = false;
      if (this.isOp('(')) {
        parens = true;
        this.next();
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.isOp(',') || this.isOp(')') ? null : this.parseExpr(0));
            if (!this.eatOp(',')) break;
          }
        }
        this.expectOp(')', `to close the call of ${t.text}`);
      }
      this.expectOp(';', `at the end of the call of ${t.text}`);
      return done({ kind: 'sysTask', name: t.text, args, parens, span: this.since(t.span) });
    }
    if (t.kind === 'ident') {
      const target = this.parseReference(true);
      if ((target.kind === 'ident' || target.kind === 'hier') && (this.isOp('(') || this.isOp(';'))) {
        const args: Expr[] = [];
        let parens = false;
        if (this.eatOp('(')) {
          parens = true;
          if (!this.isOp(')')) {
            for (;;) {
              args.push(this.parseExpr(0));
              if (!this.eatOp(',')) break;
            }
          }
          this.expectOp(')', `to close the call of '${target.name}'`);
        }
        this.expectOp(';', `at the end of the call of '${target.name}'`);
        return done({ kind: 'taskCall', callee: target, args, parens, span: this.since(t.span) });
      }
      if (target.kind === 'call') {
        // `f(x);` was read as a function call by the expression parser. As a statement it is a task call.
        this.expectOp(';', `at the end of the call of '${target.callee.name}'`);
        return done({ kind: 'taskCall', callee: target.callee, args: target.args, parens: true, span: this.since(t.span) });
      }
      return done(this.parseAssignmentRest(t, target));
    }
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'begin':
        case 'fork':
          return done(this.parseBlock());
        case 'if':
          return done(this.parseIf());
        case 'case':
        case 'casex':
        case 'casez':
          return done(this.parseCase());
        case 'for': {
          this.next();
          this.expectOp('(', "after 'for'");
          const init = this.parseLoopAssign();
          this.expectOp(';', "after the loop initialisation");
          const cond = this.parseExpr(0);
          this.expectOp(';', "after the loop condition");
          const step = this.parseLoopAssign();
          this.expectOp(')', "to close the 'for' header");
          const body = this.parseStatement();
          return done({ kind: 'for', init, cond, step, body, span: this.since(t.span) });
        }
        case 'while': {
          this.next();
          this.expectOp('(', "after 'while'");
          const cond = this.parseExpr(0);
          this.expectOp(')', 'after the condition');
          const body = this.parseStatement();
          return done({ kind: 'while', cond, body, span: this.since(t.span) });
        }
        case 'repeat': {
          this.next();
          this.expectOp('(', "after 'repeat'");
          const count = this.parseExpr(0);
          this.expectOp(')', 'after the repeat count');
          const body = this.parseStatement();
          return done({ kind: 'repeat', count, body, span: this.since(t.span) });
        }
        case 'forever': {
          this.next();
          const body = this.parseStatement();
          return done({ kind: 'forever', body, span: this.since(t.span) });
        }
        case 'wait': {
          this.next();
          this.expectOp('(', "after 'wait'");
          const cond = this.parseExpr(0);
          this.expectOp(')', 'after the condition');
          const body = this.parseStatement();
          return done({ kind: 'wait', cond, body, span: this.since(t.span) });
        }
        case 'disable': {
          this.next();
          const nt = this.peek();
          if (nt.kind !== 'ident') this.fail(nt.span, `Expected the name of a task or block after 'disable', but found ${this.describe(nt)}.`);
          const target = this.parseReference(false) as Ref;
          this.expectOp(';', "after 'disable'");
          return done({ kind: 'disable', target, span: this.since(t.span) });
        }
        case 'assign':
        case 'force': {
          this.next();
          const lhs = this.parseLvalue();
          this.expectOp('=', `after the target of '${t.text}'`);
          const rhs = this.parseExpr(0);
          this.expectOp(';', `at the end of '${t.text}'`);
          return done({ kind: 'procAssign', op: t.text as 'assign', lhs, rhs, span: this.since(t.span) });
        }
        case 'deassign':
        case 'release': {
          this.next();
          const lhs = this.parseLvalue();
          this.expectOp(';', `at the end of '${t.text}'`);
          return done({ kind: 'procAssign', op: t.text as 'deassign', lhs, span: this.since(t.span) });
        }
        case 'else':
          return this.fail(t.span, "This 'else' has no matching 'if'.");
        default:
          return this.fail(t.span, `Expected a statement, but found ${this.describe(t)}.`);
      }
    }
    return this.fail(t.span, `Expected a statement, but found ${this.describe(t)}.`);
  }

  private parseAssignment(start: Token): Stmt {
    const lhs = this.parseLvalue();
    return this.parseAssignmentRest(start, lhs);
  }

  private parseAssignmentRest(start: Token, lhs: Expr): AssignStmt {
    const op = this.peek();
    if (!(op.kind === 'op' && (op.text === '<=' || op.text === '='))) {
      return this.fail(op.span, `Expected '<=' or '=' after the assignment target, but found ${this.describe(op)}.`);
    }
    this.next();
    const control = this.parseIntraControl();
    const rhs = this.parseExpr(0);
    this.expectOp(';', 'at the end of the assignment');
    const s: AssignStmt = { kind: 'assign', lhs, rhs, blocking: op.text === '=', span: this.since(start.span) };
    if (control) s.control = control;
    return s;
  }

  private parseIf(): Stmt {
    const t = this.next();
    this.expectOp('(', "after 'if'");
    const cond = this.parseExpr(0);
    this.expectOp(')', 'after the condition');
    const then = this.parseStatement();
    let other: Stmt | undefined;
    if (this.eatKw('else')) other = this.parseStatement();
    return { kind: 'if', cond, then, else: other, span: this.since(t.span) };
  }

  private parseCase(): Stmt {
    const t = this.next();
    this.expectOp('(', `after '${t.text}'`);
    const expr = this.parseExpr(0);
    this.expectOp(')', 'after the case expression');
    const items: CaseItem[] = [];
    while (!this.isKw('endcase')) {
      if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
        this.report('syntax-error', `This '${t.text}' is never closed. Add 'endcase'.`, t.span);
        throw ABORT;
      }
      const before = this.pos;
      try {
        const start = this.peek();
        let labels: Expr[] | undefined;
        if (this.eatKw('default')) this.eatOp(':');
        else {
          labels = [];
          for (;;) {
            labels.push(this.parseExpr(0));
            if (!this.eatOp(',')) break;
          }
          this.expectOp(':', 'after the case label');
        }
        const body = this.parseStatement();
        items.push({ labels, body, span: this.since(start.span) });
      } catch (e) {
        if (e !== ABORT) throw e;
        this.syncStatement();
        if (this.pos === before) this.next();
      }
    }
    this.next();
    return { kind: 'case', flavor: t.text as 'case', expr, items, span: this.since(t.span) };
  }

  /** Declarations that may follow `begin : name`, `task`, or `function`. */
  private atBlockDecl(): boolean {
    return this.kwIn(VAR_TYPES) || this.isKw('parameter') || this.isKw('localparam');
  }

  private parseBlock(): Stmt {
    const begin = this.next();
    const parallel = begin.text === 'fork';
    const close = parallel ? 'join' : 'end';
    let name: Ident | undefined;
    const decls: BlockDecl[] = [];
    if (this.eatOp(':')) name = this.expectIdent(`after ':' in '${begin.text}'`);
    else if (this.atBlockDecl()) this.report('syntax-error', `Declarations inside '${begin.text}' need a block name. Write '${begin.text} : name' before them.`, this.peek().span);
    while (this.atBlockDecl()) {
      try {
        decls.push(...this.parseBlockDecl());
      } catch (e) {
        if (e !== ABORT) throw e;
        this.syncStatement();
      }
    }
    const stmts: Stmt[] = [];
    while (!this.isKw(close)) {
      if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
        this.report('syntax-error', `This '${begin.text}' is never closed. Add '${close}'.`, begin.span);
        throw ABORT;
      }
      if ((parallel && this.isKw('end')) || (!parallel && this.isKw('join'))) {
        const wrong = this.peek();
        this.report('syntax-error', parallel ? "This 'end' does not close a 'begin'. A 'fork' block ends with 'join'." : "This 'join' does not close a 'fork'. A 'begin' block ends with 'end'.", wrong.span);
        const b: Stmt = { kind: 'block', stmts, parallel, decls, span: this.since(begin.span) };
        if (name) b.name = name;
        this.next();
        return b;
      }
      const before = this.pos;
      try {
        stmts.push(this.parseStatement());
      } catch (e) {
        if (e !== ABORT) throw e;
        this.syncStatement();
        if (this.pos === before) this.next();
      }
    }
    this.next();
    const b: Stmt = { kind: 'block', stmts, parallel, decls, span: this.since(begin.span) };
    if (name) b.name = name;
    return b;
  }

  // ------------------------------------------------------------ declarations

  private parseStrengthKw(): Strength0 | Strength1 {
    const t = this.next();
    return t.text as Strength0 | Strength1;
  }

  /** `(strong0, pull1)`, at the opening parenthesis. A pull gate takes just one strength, as in `(pull1)`. */
  private parseDriveStrength(single = false): DriveStrength {
    const open = this.expectOp('(', 'to start the drive strength');
    const t = this.peek();
    if (!(this.kwIn(STRENGTH0) || this.kwIn(STRENGTH1))) this.fail(t.span, `Expected a strength such as strong0 or pull1, but found ${this.describe(t)}.`);
    const first = this.parseStrengthKw();
    if (single) {
      this.expectOp(')', 'to close the strength');
      return { first };
    }
    this.expectOp(',', 'between the two strengths');
    const t2 = this.peek();
    if (!(this.kwIn(STRENGTH0) || this.kwIn(STRENGTH1))) this.fail(t2.span, `Expected a second strength such as weak0 or supply1, but found ${this.describe(t2)}.`);
    const second = this.parseStrengthKw();
    const zero = (s: string) => STRENGTH0.has(s);
    if (zero(first) === zero(second)) this.fail(open.span, 'A drive strength needs one strength for 0 and one for 1, for example (strong0, weak1).');
    if (first.startsWith('highz') && second.startsWith('highz')) this.fail(open.span, 'A drive strength cannot be highz on both sides.');
    this.expectOp(')', 'to close the drive strength');
    return { first, second };
  }

  private atDriveStrength(): boolean {
    return this.isOp('(') && (this.kwIn(STRENGTH0, 1) || this.kwIn(STRENGTH1, 1));
  }

  private parseDeclarators(what: string): Declarator[] {
    const out: Declarator[] = [];
    for (;;) {
      const name = this.expectIdent(`in the '${what}' declaration`);
      const dims: RangeSpec[] = [];
      while (this.isOp('[')) dims.push(this.parseRange());
      let init: Expr | undefined;
      if (this.eatOp('=')) {
        if (dims.length > 0) this.fail(this.toks[this.pos - 1]!.span, `An array '${name.name}' cannot be given a value where it is declared.`);
        init = this.parseExpr(0);
      }
      const d: Declarator = { name, dims, span: this.since(name.span) };
      if (init) d.init = init;
      out.push(d);
      if (!this.eatOp(',')) break;
    }
    return out;
  }

  /** `wire`, `reg`, `integer`, ... declarations, including the `;`. */
  private parseNetDecl(attrs: Attribute[] | undefined): NetDecl {
    const kw = this.next();
    const net = kw.text as NetKind;
    const isNet = NET_TYPES.has(net);
    const decl: NetDecl = { kind: 'netDecl', net, signed: false, declarators: [], span: kw.span };
    if (isNet) {
      if (this.atDriveStrength()) decl.drive = this.parseDriveStrength();
      else if (net === 'trireg' && this.isOp('(') && this.kwIn(CHARGE, 1)) {
        this.next();
        decl.charge = this.next().text as ChargeStrength;
        this.expectOp(')', 'to close the charge strength');
      }
      if (this.isKw('vectored') || this.isKw('scalared')) decl.vectored = this.next().text as 'vectored' | 'scalared';
    }
    if (this.isKw('signed')) {
      if (!isNet && net !== 'reg') this.fail(this.peek().span, `'signed' cannot be used with '${net}'.`);
      this.next();
      decl.signed = true;
    }
    if (this.isOp('[')) {
      if (!isNet && net !== 'reg') this.fail(this.peek().span, `'${net}' cannot have a range.`);
      decl.range = this.parseRange();
    }
    if (isNet && this.isOp('#')) decl.delay = this.parseDelay();
    decl.declarators = this.parseDeclarators(net);
    this.expectOp(';', `at the end of the '${net}' declaration`);
    decl.span = this.since(kw.span);
    return this.withAttrs(decl, attrs);
  }

  private parseParamTypeAndRange(): { type?: ParamDecl['type']; signed: boolean; range?: RangeSpec } {
    let type: ParamDecl['type'];
    let signed = false;
    let range: RangeSpec | undefined;
    const t = this.peek();
    if (t.kind === 'keyword' && (t.text === 'integer' || t.text === 'real' || t.text === 'realtime' || t.text === 'time')) {
      this.next();
      type = t.text as ParamDecl['type'];
    } else {
      if (this.eatKw('signed')) signed = true;
      if (this.isOp('[')) range = this.parseRange();
    }
    return { type, signed, range };
  }

  private parseParamAssign(): ParamAssign {
    const name = this.expectIdent('for the parameter');
    this.expectOp('=', `after the parameter name '${name.name}'`);
    const value = this.parseMinTypMax();
    return { name, value, span: this.since(name.span) };
  }

  /** `parameter` or `localparam`, with its `;`. */
  private parseParamDecl(attrs: Attribute[] | undefined): ParamDecl {
    const kw = this.next();
    const { type, signed, range } = this.parseParamTypeAndRange();
    const assigns: ParamAssign[] = [];
    for (;;) {
      assigns.push(this.parseParamAssign());
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', `at the end of the '${kw.text}' declaration`);
    const d: ParamDecl = { kind: 'paramDecl', local: kw.text === 'localparam', signed, assigns, span: this.since(kw.span) };
    if (type) d.type = type;
    if (range) d.range = range;
    return this.withAttrs(d, attrs);
  }

  private parseSpecparam(attrs: Attribute[] | undefined): SpecparamDecl {
    const kw = this.next();
    const range = this.isOp('[') ? this.parseRange() : undefined;
    const assigns: SpecparamDecl['assigns'] = [];
    for (;;) {
      const name = this.expectIdent("for the 'specparam'");
      this.expectOp('=', `after the specparam name '${name.name}'`);
      let value: Expr | DelayList;
      if (this.isOp('(') && /^PATHPULSE\$/.test(name.name)) {
        const open = this.next();
        const values: Expr[] = [this.parseMinTypMax()];
        while (this.eatOp(',')) values.push(this.parseMinTypMax());
        this.expectOp(')', 'to close the pulse limits');
        value = { values, span: this.since(open.span) };
      } else value = this.parseMinTypMax();
      assigns.push({ name, value, span: this.since(name.span) });
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', "at the end of the 'specparam' declaration");
    const d: SpecparamDecl = { kind: 'specparamDecl', assigns, span: this.since(kw.span) };
    if (range) d.range = range;
    return this.withAttrs(d, attrs);
  }

  /** A declaration allowed after `begin : name`, in a function or in a task. */
  private parseBlockDecl(): BlockDecl[] {
    const attrs = this.parseAttrs();
    const t = this.peek();
    if (t.kind === 'keyword' && (t.text === 'parameter' || t.text === 'localparam')) return [this.parseParamDecl(attrs)];
    if (t.kind === 'keyword' && VAR_TYPES.has(t.text)) return [this.parseNetDecl(attrs)];
    return this.fail(t.span, `Expected a declaration, but found ${this.describe(t)}.`);
  }

  /** `input [3:0] a, b;` in a module, function or task body. */
  private parsePortDeclItem(attrs: Attribute[] | undefined): PortDeclItem {
    const kw = this.next();
    const dir = kw.text as PortDeclItem['dir'];
    const d: PortDeclItem = { kind: 'portDecl', dir, signed: false, names: [], span: kw.span };
    const t = this.peek();
    if (t.kind === 'keyword' && (NET_TYPES.has(t.text) || VAR_TYPES.has(t.text)) && t.text !== 'event') {
      this.next();
      d.net = t.text as NetKind;
    }
    if (this.eatKw('signed')) d.signed = true;
    if (this.isOp('[')) d.range = this.parseRange();
    for (;;) {
      const name = this.expectIdent(`in the '${dir}' declaration`);
      const entry: PortDeclItem['names'][number] = { name };
      if (this.eatOp('=')) entry.init = this.parseExpr(0);
      d.names.push(entry);
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', `at the end of the '${dir}' declaration`);
    d.span = this.since(kw.span);
    return this.withAttrs(d, attrs);
  }

  // ------------------------------------------------------------ continuous assignments, gates, instances

  private parseContinuousAssign(attrs: Attribute[] | undefined): ModuleItem[] {
    const kw = this.next();
    const drive = this.atDriveStrength() ? this.parseDriveStrength() : undefined;
    const delay = this.isOp('#') ? this.parseDelay() : undefined;
    const items: ModuleItem[] = [];
    for (;;) {
      const lhs = this.parseLvalue();
      this.expectOp('=', 'after the assignment target');
      const rhs = this.parseExpr(0);
      const a: ModuleItem = { kind: 'continuousAssign', lhs, rhs, span: joinSpans(lhs.span, rhs.span) };
      if (drive) a.drive = drive;
      if (delay) a.delay = delay;
      items.push(this.withAttrs(a, attrs));
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', 'at the end of the assignment');
    items.forEach((it) => (it.span = joinSpans(kw.span, it.span)));
    return items;
  }

  private parseTerminals(what: string): Expr[] {
    this.expectOp('(', `after ${what}`);
    const out: Expr[] = [];
    for (;;) {
      out.push(this.parseExpr(0));
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')', `to close the terminals of ${what}`);
    return out;
  }

  private parseGates(attrs: Attribute[] | undefined): ModuleItem[] {
    const kw = this.next();
    const gate = kw.text as GateKind;
    const pull = gate === 'pullup' || gate === 'pulldown';
    const drive = this.atDriveStrength() ? this.parseDriveStrength(pull) : undefined;
    const delay = !pull && this.isOp('#') ? this.parseDelay() : undefined;
    const items: ModuleItem[] = [];
    for (;;) {
      let name: Ident | undefined;
      let range: RangeSpec | undefined;
      if (this.peek().kind === 'ident') {
        name = this.expectIdent(`for the '${gate}'`);
        if (this.isOp('[')) range = this.parseRange();
      }
      const terminals = this.parseTerminals(`the '${gate}'${name ? ` '${name.name}'` : ''}`);
      const g: GateInst = { kind: 'gate', gate, terminals, span: joinSpans(kw.span, this.toks[this.pos - 1]!.span) };
      if (drive) g.drive = drive;
      if (delay) g.delay = delay;
      if (name) g.name = name;
      if (range) g.range = range;
      items.push(this.withAttrs(g, attrs));
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', `at the end of the '${gate}'`);
    items.forEach((it) => (it.span = joinSpans(kw.span, this.toks[this.pos - 1]!.span)));
    return items;
  }

  private parseParamOverrides(): ParamOverrides {
    this.expectOp('#', 'to start the parameter values');
    const t = this.peek();
    if (t.kind === 'number') {
      this.next();
      return { style: 'ordered', items: [this.isRealLiteral(t.text) ? { kind: 'real', text: t.text, span: t.span } : { kind: 'number', text: t.text, span: t.span }] };
    }
    if (t.kind === 'ident') return { style: 'ordered', items: [this.parseReference(false) as Expr] };
    this.expectOp('(', "after '#'");
    if (this.isOp('.')) {
      const items: NamedParamValue[] = [];
      for (;;) {
        const dot = this.expectOp('.', 'to start a named parameter value');
        const name = this.expectIdent("after '.'");
        this.expectOp('(', `after the parameter name '${name.name}'`);
        const value = this.isOp(')') ? undefined : this.parseMinTypMax();
        const close = this.expectOp(')', `to close the value of '${name.name}'`);
        const item: NamedParamValue = { name, span: joinSpans(dot.span, close.span) };
        if (value) item.value = value;
        items.push(item);
        if (!this.eatOp(',')) break;
      }
      this.expectOp(')', 'to close the parameter values');
      return { style: 'named', items };
    }
    const items: Expr[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        items.push(this.parseMinTypMax());
        if (!this.eatOp(',')) break;
      }
    }
    this.expectOp(')', 'to close the parameter values');
    return { style: 'ordered', items };
  }

  private parseConnections(inst: Instance, label: string) {
    this.expectOp('(', `after ${label}`);
    if (!this.isOp(')')) {
      const named = this.isOp('.') || (this.isOp('(*') && this.attrsThenDot());
      if (named) {
        for (;;) {
          const attrs = this.parseAttrs();
          const dot = this.expectOp('.', 'to start a named port connection');
          const port = this.expectIdent("after '.'");
          this.expectOp('(', `after the port name '${port.name}'`);
          const expr = this.isOp(')') ? undefined : this.parseExpr(0);
          const close = this.expectOp(')', `to close the connection to '${port.name}'`);
          const c: Connection = { port, span: joinSpans(dot.span, close.span) };
          if (expr) c.expr = expr;
          inst.conns.push(this.withAttrs(c, attrs));
          if (!this.eatOp(',')) break;
        }
      } else {
        inst.ordered = [];
        for (;;) {
          const attrs = this.parseAttrs();
          const start = this.peek();
          const expr = this.isOp(',') || this.isOp(')') ? undefined : this.parseExpr(0);
          const c: OrderedConnection = { span: expr ? expr.span : start.span };
          if (expr) c.expr = expr;
          inst.ordered.push(this.withAttrs(c, attrs));
          if (!this.eatOp(',')) break;
        }
      }
    }
    this.expectOp(')', `to close the connections of ${label}`);
  }

  /** Whether the attribute list starting here is followed by '.', that is a named connection. */
  private attrsThenDot(): boolean {
    let k = 0;
    while (this.peek(k).kind !== 'eof' && !(this.peek(k).kind === 'op' && this.peek(k).text === '*)')) k++;
    return this.isOp('.', k + 1);
  }

  private parseInstances(attrs: Attribute[] | undefined): ModuleItem[] {
    const module = this.expectIdent('for the module');
    let params = this.isOp('#') ? this.parseParamOverrides() : undefined;
    const drive = this.atDriveStrength() ? this.parseDriveStrength() : undefined;
    // A user primitive may have its delay after the strength: `nand2 (strong0, weak1) #3 u (...)`.
    if (drive && !params && this.isOp('#')) params = this.parseParamOverrides();
    const items: Instance[] = [];
    for (;;) {
      let name: Ident | undefined;
      let range: RangeSpec | undefined;
      if (this.peek().kind === 'ident') {
        name = this.expectIdent(`for the instance of '${module.name}'`);
        if (this.isOp('[')) range = this.parseRange();
      } else if (!this.isOp('(')) {
        const t = this.peek();
        this.fail(t.span, `Expected an instance name after '${module.name}', but found ${this.describe(t)}.`);
      }
      const inst: Instance = { kind: 'instance', module, conns: [], span: module.span };
      if (params) inst.params = params;
      if (drive) inst.drive = drive;
      if (name) inst.name = name;
      if (range) inst.range = range;
      this.parseConnections(inst, name ? `the instance '${name.name}'` : `the instance of '${module.name}'`);
      inst.span = joinSpans(module.span, this.toks[this.pos - 1]!.span);
      items.push(this.withAttrs(inst, attrs));
      if (!this.eatOp(',')) break;
    }
    this.expectOp(';', 'at the end of the instance');
    return items;
  }

  // ------------------------------------------------------------ generate

  private parseGenerateBlock(): GenerateBlock {
    const start = this.peek();
    if (this.eatOp(';')) return { explicit: false, items: [], span: start.span };
    if (this.isKw('begin')) {
      this.next();
      let name: Ident | undefined;
      if (this.eatOp(':')) name = this.expectIdent("after ':' in 'begin'");
      const items = this.parseItemsUntil(['end'], start);
      this.next();
      const b: GenerateBlock = { explicit: true, items, span: this.since(start.span) };
      if (name) b.name = name;
      return b;
    }
    const items = this.parseItem();
    // A bare item that the parser split into several (`assign a = 1, b = 2;`) reads back the same only inside begin/end.
    return { explicit: items.length > 1, items, span: this.since(start.span) };
  }

  private parseGenerateFor(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    this.expectOp('(', "after 'for'");
    const g1 = this.expectIdent('for the genvar');
    this.expectOp('=', 'after the genvar');
    const v1 = this.parseExpr(0);
    this.expectOp(';', 'after the genvar initialisation');
    const cond = this.parseExpr(0);
    this.expectOp(';', 'after the loop condition');
    const g2 = this.expectIdent('for the genvar');
    this.expectOp('=', 'after the genvar');
    const v2 = this.parseExpr(0);
    this.expectOp(')', "to close the 'for' header");
    const body = this.parseGenerateBlock();
    return this.withAttrs<GenerateFor>({ kind: 'generateFor', init: { genvar: g1, value: v1 }, cond, step: { genvar: g2, value: v2 }, body, span: this.since(kw.span) }, attrs);
  }

  private parseGenerateIf(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    this.expectOp('(', "after 'if'");
    const cond = this.parseExpr(0);
    this.expectOp(')', 'after the condition');
    const then = this.parseGenerateBlock();
    const node: ModuleItem = { kind: 'generateIf', cond, then, span: kw.span };
    if (this.eatKw('else')) node.else = this.parseGenerateBlock();
    node.span = this.since(kw.span);
    return this.withAttrs(node, attrs);
  }

  private parseGenerateCase(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    this.expectOp('(', "after 'case'");
    const expr = this.parseExpr(0);
    this.expectOp(')', 'after the case expression');
    const items: GenerateCaseItem[] = [];
    while (!this.isKw('endcase')) {
      if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
        this.report('syntax-error', "This 'case' is never closed. Add 'endcase'.", kw.span);
        throw ABORT;
      }
      const before = this.pos;
      try {
        const start = this.peek();
        let labels: Expr[] | undefined;
        if (this.eatKw('default')) this.eatOp(':');
        else {
          labels = [];
          for (;;) {
            labels.push(this.parseExpr(0));
            if (!this.eatOp(',')) break;
          }
          this.expectOp(':', 'after the case label');
        }
        const body = this.parseGenerateBlock();
        const item: GenerateCaseItem = { body, span: this.since(start.span) };
        if (labels) item.labels = labels;
        items.push(item);
      } catch (e) {
        if (e !== ABORT) throw e;
        this.syncItem();
        if (this.pos === before) this.next();
      }
    }
    this.next();
    return this.withAttrs<GenerateCase>({ kind: 'generateCase', expr, items, span: this.since(kw.span) }, attrs);
  }

  // ------------------------------------------------------------ functions and tasks

  private parseTfPorts(isFunction: boolean): TfPort[] {
    this.expectOp('(', 'to start the port list');
    const ports: TfPort[] = [];
    if (this.eatOp(')')) return ports;
    let prev: Pick<TfPort, 'dir' | 'net' | 'signed' | 'range' | 'attrs'> | undefined;
    for (;;) {
      const attrs = this.parseAttrs();
      const t = this.peek();
      if (t.kind === 'keyword' && (t.text === 'input' || t.text === 'output' || t.text === 'inout')) {
        this.next();
        if (isFunction && t.text !== 'input') this.fail(t.span, `A function can only have 'input' ports, not '${t.text}'.`);
        const dir = t.text as TfPort['dir'];
        let net: NetKind | undefined;
        let signed = false;
        let range: RangeSpec | undefined;
        const nt = this.peek();
        if (nt.kind === 'keyword' && (nt.text === 'reg' || nt.text === 'integer' || nt.text === 'real' || nt.text === 'realtime' || nt.text === 'time' || NET_TYPES.has(nt.text))) {
          this.next();
          net = nt.text as NetKind;
        }
        if (this.eatKw('signed')) signed = true;
        if (this.isOp('[')) range = this.parseRange();
        const name = this.expectIdent('for the port');
        const p: TfPort = { dir, signed, name, span: this.since(t.span) };
        if (net) p.net = net;
        if (range) p.range = range;
        ports.push(this.withAttrs(p, attrs));
        prev = { dir, net, signed, range, attrs };
      } else if (t.kind === 'ident' && prev) {
        const name = this.expectIdent('for the port');
        const p: TfPort = { dir: prev.dir, signed: prev.signed, name, span: name.span };
        if (prev.net) p.net = prev.net;
        if (prev.range) p.range = prev.range;
        ports.push(this.withAttrs(p, prev.attrs));
      } else return this.fail(t.span, `Expected 'input'${isFunction ? '' : ", 'output' or 'inout'"} to declare a port, but found ${this.describe(t)}.`);
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')', 'to close the port list');
    return ports;
  }

  /** Port and variable declarations that open a function or task body. */
  private parseTfDecls(): BlockDecl[] {
    const decls: BlockDecl[] = [];
    for (;;) {
      const save = this.pos;
      const attrs = this.parseAttrs();
      const t = this.peek();
      if (t.kind === 'keyword' && (t.text === 'input' || t.text === 'output' || t.text === 'inout')) decls.push(this.parsePortDeclItem(attrs));
      else if (t.kind === 'keyword' && (VAR_TYPES.has(t.text) || t.text === 'parameter' || t.text === 'localparam')) {
        this.pos = save;
        decls.push(...this.parseBlockDecl());
      } else {
        this.pos = save;
        return decls;
      }
    }
  }

  private parseFunction(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    const automatic = !!this.eatKw('automatic');
    let signed = false;
    let range: RangeSpec | undefined;
    let type: FunctionDecl['type'];
    if (this.eatKw('reg')) type = 'reg';
    if (this.eatKw('signed')) signed = true;
    if (this.isOp('[')) range = this.parseRange();
    else if (!type && this.kwIn(new Set(['integer', 'real', 'realtime', 'time']))) type = this.next().text as FunctionDecl['type'];
    const name = this.expectIdent("after 'function'");
    let ports: TfPort[] = [];
    let ansi = false;
    if (this.isOp('(')) {
      ansi = true;
      ports = this.parseTfPorts(true);
    }
    this.expectOp(';', 'after the function header');
    const decls = this.parseTfDecls();
    let body: Stmt;
    if (this.isKw('endfunction')) body = { kind: 'empty', span: this.peek().span };
    else body = this.parseStatement();
    this.expectKw('endfunction', `to end the function '${name.name}'`);
    const f: FunctionDecl = { kind: 'function', automatic, signed, name, ports, ansi, decls, body, span: this.since(kw.span) };
    if (range) f.range = range;
    if (type) f.type = type;
    return this.withAttrs(f, attrs);
  }

  private parseTask(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    const automatic = !!this.eatKw('automatic');
    const name = this.expectIdent("after 'task'");
    let ports: TfPort[] = [];
    let ansi = false;
    if (this.isOp('(')) {
      ansi = true;
      ports = this.parseTfPorts(false);
    }
    this.expectOp(';', 'after the task header');
    const decls = this.parseTfDecls();
    let body: Stmt;
    if (this.isKw('endtask')) body = { kind: 'empty', span: this.peek().span };
    else body = this.parseStatement();
    this.expectKw('endtask', `to end the task '${name.name}'`);
    return this.withAttrs({ kind: 'task', automatic, name, ports, ansi, decls, body, span: this.since(kw.span) } as TaskDecl, attrs);
  }

  // ------------------------------------------------------------ specify blocks

  /** A terminal of a path or a timing check: a name with an optional bit or part select. */
  private parseTerminal(): Expr {
    const t = this.peek();
    if (t.kind !== 'ident') return this.fail(t.span, `Expected a signal name, but found ${this.describe(t)}.`);
    return this.parseReference(true);
  }

  private parsePath(cond: PathDecl['cond'], start: Token): PathDecl {
    this.expectOp('(', 'to start the path');
    let edge: PathDecl['edge'];
    if (this.isKw('posedge') || this.isKw('negedge')) edge = this.next().text as 'posedge';
    const inputs: Expr[] = [];
    for (;;) {
      inputs.push(this.parseTerminal());
      if (!this.eatOp(',')) break;
    }
    let inPolarity: '+' | '-' | undefined;
    if (this.isOp('+') || this.isOp('-')) inPolarity = this.next().text as '+';
    const conn = this.peek();
    if (!(conn.kind === 'op' && (conn.text === '=>' || conn.text === '*>'))) this.fail(conn.span, `Expected '=>' or '*>' in the path, but found ${this.describe(conn)}.`);
    this.next();
    const path: PathDecl = { kind: 'path', inputs, connection: conn.text as '=>', outputs: [], delays: [], span: start.span };
    if (cond) path.cond = cond;
    if (edge) path.edge = edge;
    if (inPolarity) path.inPolarity = inPolarity;
    const parenthesised = this.isOp('(');
    if (parenthesised) this.next();
    for (;;) {
      path.outputs.push(this.parseTerminal());
      if (!this.eatOp(',')) break;
    }
    if (parenthesised) {
      if (this.isOp('+') || this.isOp('-')) {
        path.outPolarity = this.next().text as '+';
        this.expectOp(':', "after the polarity in the path's data source");
        path.dataSource = this.parseExpr(0);
      } else if (this.isOp('+:') || this.isOp('-:')) {
        path.outPolarity = this.next().text[0] as '+';
        path.dataSource = this.parseExpr(0);
      } else if (this.eatOp(':')) path.dataSource = this.parseExpr(0);
      this.expectOp(')', 'to close the path output');
    }
    this.expectOp(')', 'to close the path');
    this.expectOp('=', 'after the path');
    if (this.isOp('(')) {
      this.next();
      for (;;) {
        path.delays.push(this.parseMinTypMax());
        if (!this.eatOp(',')) break;
      }
      this.expectOp(')', 'to close the path delays');
    } else path.delays.push(this.parseMinTypMax());
    this.expectOp(';', 'at the end of the path delay');
    path.span = this.since(start.span);
    return path;
  }

  private parseTimingArg(): TimingArg {
    const start = this.peek();
    const arg: TimingArg = { expr: undefined as unknown as Expr, span: start.span };
    if (this.isKw('posedge') || this.isKw('negedge')) arg.edge = this.next().text as 'posedge';
    else if (this.isKw('edge')) {
      this.next();
      arg.edge = 'edge';
      this.expectOp('[', "after 'edge'");
      const descriptors: string[] = [];
      let cur = '';
      while (!this.eof && !this.isOp(']')) {
        if (this.isOp(',')) {
          descriptors.push(cur);
          cur = '';
        } else cur += this.peek().text;
        this.next();
      }
      if (cur) descriptors.push(cur);
      this.expectOp(']', 'to close the edge list');
      arg.descriptors = descriptors;
    }
    arg.expr = this.parseMinTypMax();
    if (this.eatOp('&&&')) arg.cond = this.parseExpr(0);
    arg.span = this.since(start.span);
    return arg;
  }

  private parseSpecifyItem(): SpecifyItem {
    const t = this.peek();
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'specparam':
          return this.parseSpecparam(undefined);
        case 'pulsestyle_onevent':
        case 'pulsestyle_ondetect':
        case 'showcancelled':
        case 'noshowcancelled': {
          this.next();
          const outputs: Expr[] = [];
          for (;;) {
            outputs.push(this.parseTerminal());
            if (!this.eatOp(',')) break;
          }
          this.expectOp(';', `at the end of '${t.text}'`);
          return { kind: 'pulseStyle', style: t.text as SpecPulse, outputs, span: this.since(t.span) };
        }
        case 'if': {
          this.next();
          this.expectOp('(', "after 'if'");
          const expr = this.parseExpr(0);
          this.expectOp(')', 'after the condition');
          return this.parsePath({ kind: 'if', expr }, t);
        }
        case 'ifnone':
          this.next();
          return this.parsePath({ kind: 'ifnone' }, t);
        default:
      }
    }
    if (t.kind === 'op' && t.text === '(') return this.parsePath(undefined, t);
    if (t.kind === 'system' && TIMING_CHECKS.has(t.text)) {
      this.next();
      this.expectOp('(', `after ${t.text}`);
      const args: (TimingArg | null)[] = [];
      for (;;) {
        args.push(this.isOp(',') || this.isOp(')') ? null : this.parseTimingArg());
        if (!this.eatOp(',')) break;
      }
      this.expectOp(')', `to close ${t.text}`);
      this.expectOp(';', `at the end of ${t.text}`);
      const c: TimingCheck = { kind: 'timingCheck', name: t.text, args, span: this.since(t.span) };
      return c;
    }
    return this.fail(t.span, `Expected a path delay, a timing check or a specparam in the specify block, but found ${this.describe(t)}.`);
  }

  private parseSpecify(attrs: Attribute[] | undefined): ModuleItem {
    const kw = this.next();
    const items: SpecifyItem[] = [];
    while (!this.isKw('endspecify')) {
      if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
        this.report('syntax-error', "This 'specify' is never closed. Add 'endspecify'.", kw.span);
        throw ABORT;
      }
      const before = this.pos;
      try {
        items.push(this.parseSpecifyItem());
      } catch (e) {
        if (e !== ABORT) throw e;
        this.skipSpecifyItem();
        if (this.pos === before) this.next();
      }
    }
    this.next();
    return this.withAttrs<SpecifyBlock>({ kind: 'specify', items, span: this.since(kw.span) }, attrs);
  }

  private skipSpecifyItem() {
    let parens = 0;
    while (!this.eof && !this.isKw('endspecify') && !this.isKw('endmodule')) {
      if (this.isOp('(')) parens++;
      else if (this.isOp(')')) parens = Math.max(0, parens - 1);
      else if (this.isOp(';') && parens === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  // ------------------------------------------------------------ module items

  /** Parse items up to (not including) one of the closing keywords. */
  private parseItemsUntil(closers: string[], opener: Token): ModuleItem[] {
    const items: ModuleItem[] = [];
    while (!(this.peek().kind === 'keyword' && closers.includes(this.peek().text))) {
      if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
        this.report('syntax-error', `This '${opener.text}' is never closed. Add '${closers[0]}'.`, opener.span);
        throw ABORT;
      }
      const before = this.pos;
      try {
        items.push(...this.parseItem());
      } catch (e) {
        if (e !== ABORT) throw e;
        this.syncItem();
        if (this.pos === before) this.next();
      }
    }
    return items;
  }

  private parseItem(): ModuleItem[] {
    return this.nested('These generate blocks are', () => this.parseItemBody());
  }

  private parseItemBody(): ModuleItem[] {
    const attrs = this.parseAttrs();
    const t = this.peek();
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'assign':
          return this.parseContinuousAssign(attrs);
        case 'always':
        case 'initial': {
          this.next();
          if (t.text === 'always' && this.isOp('@')) {
            const control = this.parseEventControl();
            const body = this.parseStatement();
            return [this.withAttrs({ kind: 'always', events: control.events, body, span: this.since(t.span) } as AlwaysBlock, attrs)];
          }
          const body = this.parseStatement();
          return [t.text === 'always' ? this.withAttrs<AlwaysBlock>({ kind: 'always', body, span: this.since(t.span) }, attrs) : this.withAttrs<InitialBlock>({ kind: 'initial', body, span: this.since(t.span) }, attrs)];
        }
        case 'input':
        case 'output':
        case 'inout':
          return [this.parsePortDeclItem(attrs)];
        case 'parameter':
        case 'localparam':
          return [this.parseParamDecl(attrs)];
        case 'specparam':
          return [this.parseSpecparam(attrs)];
        case 'genvar': {
          this.next();
          const names: Ident[] = [];
          for (;;) {
            names.push(this.expectIdent("in the 'genvar' declaration"));
            if (!this.eatOp(',')) break;
          }
          this.expectOp(';', "at the end of the 'genvar' declaration");
          return [this.withAttrs<GenvarDecl>({ kind: 'genvarDecl', names, span: this.since(t.span) }, attrs)];
        }
        case 'defparam': {
          this.next();
          const assigns: { target: Ref; value: Expr; span: Span }[] = [];
          for (;;) {
            const nt = this.peek();
            if (nt.kind !== 'ident') this.fail(nt.span, `Expected the name of a parameter after 'defparam', but found ${this.describe(nt)}.`);
            const target = this.parseReference(false) as Ref;
            this.expectOp('=', 'after the parameter name');
            const value = this.parseMinTypMax();
            assigns.push({ target, value, span: this.since(nt.span) });
            if (!this.eatOp(',')) break;
          }
          this.expectOp(';', "at the end of 'defparam'");
          return [this.withAttrs<DefparamItem>({ kind: 'defparam', assigns, span: this.since(t.span) }, attrs)];
        }
        case 'generate': {
          this.next();
          const items = this.parseItemsUntil(['endgenerate'], t);
          this.next();
          return [this.withAttrs<GenerateRegion>({ kind: 'generateRegion', items, span: this.since(t.span) }, attrs)];
        }
        case 'for':
          return [this.parseGenerateFor(attrs)];
        case 'if':
          return [this.parseGenerateIf(attrs)];
        case 'case':
          return [this.parseGenerateCase(attrs)];
        case 'function':
        case 'task':
          try {
            return [t.text === 'function' ? this.parseFunction(attrs) : this.parseTask(attrs)];
          } catch (e) {
            if (e !== ABORT) throw e;
            this.skipThrough(t.text === 'function' ? 'endfunction' : 'endtask');
            return [];
          }
        case 'specify':
          return [this.parseSpecify(attrs)];
        default:
          if (NET_TYPES.has(t.text) || VAR_TYPES.has(t.text)) return [this.parseNetDecl(attrs)];
          if (GATES.has(t.text)) return this.parseGates(attrs);
          return this.fail(t.span, `Unexpected ${this.describe(t)} in a module body.`);
      }
    }
    if (t.kind === 'ident') return this.parseInstances(attrs);
    if (t.kind === 'op' && t.text === ';' && !attrs) {
      this.next();
      return [];
    }
    return this.fail(t.span, `Unexpected ${this.describe(t)} in a module body.`);
  }

  // ------------------------------------------------------------ module headers

  private parseParamPorts(): ParamDecl[] {
    this.expectOp('#', 'to start the parameter list');
    this.expectOp('(', "after '#'");
    const out: ParamDecl[] = [];
    let prev: { type?: ParamDecl['type']; signed: boolean; range?: RangeSpec; attrs?: Attribute[] } | undefined;
    for (;;) {
      const attrs = this.parseAttrs();
      const start = this.peek();
      if (this.isKw('parameter')) {
        this.next();
        prev = { ...this.parseParamTypeAndRange(), attrs };
      } else if (this.isKw('localparam')) {
        this.fail(start.span, "A parameter port list declares 'parameter's. Declare a 'localparam' in the module body.");
      } else if (!prev) {
        prev = { signed: false, attrs };
      }
      const a = this.parseParamAssign();
      const d: ParamDecl = { kind: 'paramDecl', local: false, signed: prev.signed, assigns: [a], span: this.since(start.span) };
      if (prev.type) d.type = prev.type;
      if (prev.range) d.range = prev.range;
      out.push(this.withAttrs(d, prev.attrs));
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')', 'to close the parameter list');
    return out;
  }

  /** ANSI port list, after the opening parenthesis (which is consumed). */
  private parseAnsiPorts(): PortDecl[] {
    const ports: PortDecl[] = [];
    let prev: Pick<PortDecl, 'dir' | 'net' | 'signed' | 'range' | 'attrs'> | undefined;
    for (;;) {
      const attrs = this.parseAttrs();
      const t = this.peek();
      if (t.kind === 'keyword' && (t.text === 'input' || t.text === 'output' || t.text === 'inout')) {
        this.next();
        const dir = t.text as PortDecl['dir'];
        let net: NetKind | undefined;
        let signed = false;
        let range: RangeSpec | undefined;
        const nt = this.peek();
        if (nt.kind === 'keyword' && ((NET_TYPES.has(nt.text) || VAR_TYPES.has(nt.text)) && nt.text !== 'event')) {
          this.next();
          net = nt.text as NetKind;
        }
        if (this.eatKw('signed')) signed = true;
        if (this.isOp('[')) range = this.parseRange();
        const name = this.expectIdent('for the port');
        const port: PortDecl = { dir, signed, name, span: this.since(t.span) };
        if (net) port.net = net;
        if (range) port.range = range;
        if (this.eatOp('=')) port.init = this.parseExpr(0);
        ports.push(this.withAttrs(port, attrs));
        prev = { dir, net, signed, range, attrs };
      } else if (t.kind === 'ident' && prev) {
        const name = this.expectIdent('for the port');
        const port: PortDecl = { dir: prev.dir, signed: prev.signed, name, span: name.span };
        if (prev.net) port.net = prev.net;
        if (prev.range) port.range = prev.range;
        if (this.eatOp('=')) port.init = this.parseExpr(0);
        ports.push(this.withAttrs(port, prev.attrs));
      } else {
        return this.fail(t.span, `Expected 'input', 'output' or 'inout' to declare a port, but found ${this.describe(t)}.`);
      }
      if (!this.eatOp(',')) break;
    }
    return ports;
  }

  private parsePortRef(): PortRef {
    const name = this.expectIdent('for the port');
    const ref: PortRef = { name, span: name.span };
    if (this.isOp('[')) {
      const s = this.parseSelect();
      ref.select = { hi: s.hi, lo: s.lo, mode: s.mode };
      ref.span = joinSpans(name.span, s.close.span);
    }
    return ref;
  }

  /** Non-ANSI port list, after the opening parenthesis (which is consumed). */
  private parseNonAnsiPorts(): NonAnsiPort[] {
    const ports: NonAnsiPort[] = [];
    for (;;) {
      const start = this.peek();
      const port: NonAnsiPort = { refs: [], braced: false, span: start.span };
      if (this.eatOp('.')) {
        port.external = this.expectIdent("after '.'");
        this.expectOp('(', 'after the port name');
        if (!this.isOp(')')) this.parsePortExpression(port);
        this.expectOp(')', 'to close the port expression');
      } else if (!this.isOp(',') && !this.isOp(')')) this.parsePortExpression(port);
      port.span = this.since(start.span);
      ports.push(port);
      if (!this.eatOp(',')) break;
    }
    return ports;
  }

  private parsePortExpression(port: NonAnsiPort) {
    if (this.eatOp('{')) {
      port.braced = true;
      for (;;) {
        port.refs.push(this.parsePortRef());
        if (!this.eatOp(',')) break;
      }
      this.expectOp('}', "to close the port concatenation '{'");
    } else port.refs.push(this.parsePortRef());
  }

  private parseModule(attrs: Attribute[] | undefined): ModuleDecl | null {
    const kw = this.next();
    let name: Ident;
    try {
      name = this.expectIdent(`after '${kw.text}'`);
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endmodule');
      return null;
    }
    const mod: ModuleDecl = { kind: 'module', name, macro: kw.text === 'macromodule', portStyle: 'none', ports: [], portList: [], items: [], span: kw.span };
    try {
      if (this.isOp('#')) mod.paramPorts = this.parseParamPorts();
      if (this.isOp('(')) {
        this.next();
        if (this.eatOp(')')) mod.portStyle = 'ansi';
        else if (this.kwIn(new Set(['input', 'output', 'inout'])) || this.isOp('(*')) {
          mod.portStyle = 'ansi';
          mod.ports = this.parseAnsiPorts();
          this.expectOp(')', 'to close the port list');
        } else {
          mod.portStyle = 'nonansi';
          mod.portList = this.parseNonAnsiPorts();
          this.expectOp(')', 'to close the port list');
        }
      }
      this.expectOp(';', 'after the module header');
    } catch (e) {
      if (e !== ABORT) throw e;
      this.syncItem();
      this.eatOp(';');
    }
    while (!this.isKw('endmodule')) {
      if (this.eof || this.isKw('module') || this.isKw('macromodule') || this.isKw('primitive')) {
        this.report('syntax-error', `The module '${name.name}' is never closed. Add 'endmodule'.`, name.span);
        break;
      }
      const before = this.pos;
      try {
        mod.items.push(...this.parseItem());
      } catch (e) {
        if (e === ABORT_MODULE) {
          while (!this.eof && !this.isKw('endmodule') && !this.isKw('module')) this.next();
          break;
        }
        if (e !== ABORT) throw e;
        this.syncItem();
        if (this.pos === before) this.next();
      }
    }
    const end = this.eatKw('endmodule');
    mod.span = joinSpans(kw.span, (end ?? this.toks[this.pos - 1]!).span);
    return this.withAttrs(mod, attrs);
  }

  // ------------------------------------------------------------ user-defined primitives

  private parseUdp(attrs: Attribute[] | undefined): UdpDecl | null {
    const kw = this.next();
    let name: Ident;
    try {
      name = this.expectIdent("after 'primitive'");
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endprimitive');
      return null;
    }
    const udp: UdpDecl = { kind: 'udp', name, ports: [], names: [], ansi: false, decls: [], sequential: false, entries: [], span: kw.span };
    try {
      this.expectOp('(', 'to start the primitive port list');
      if (this.kwIn(new Set(['input', 'output'])) || this.isOp('(*')) {
        udp.ansi = true;
        let prev: Pick<UdpPort, 'dir' | 'reg'> | undefined;
        for (;;) {
          this.parseAttrs();
          const t = this.peek();
          let port: UdpPort;
          if (t.kind === 'keyword' && (t.text === 'input' || t.text === 'output')) {
            this.next();
            const reg = !!this.eatKw('reg');
            const pname = this.expectIdent('for the port');
            port = { dir: t.text as 'input' | 'output', reg, name: pname, span: this.since(t.span) };
            prev = { dir: port.dir, reg };
          } else if (t.kind === 'ident' && prev) {
            const pname = this.expectIdent('for the port');
            port = { dir: prev.dir, reg: prev.reg && prev.dir === 'output', name: pname, span: pname.span };
          } else return this.fail(t.span, `Expected 'input' or 'output' to declare a port, but found ${this.describe(t)}.`);
          if (this.eatOp('=')) port.init = this.parseExpr(0);
          udp.ports.push(port);
          if (!this.eatOp(',')) break;
        }
      } else {
        for (;;) {
          udp.names.push(this.expectIdent('for the port'));
          if (!this.eatOp(',')) break;
        }
      }
      this.expectOp(')', 'to close the port list');
      this.expectOp(';', 'after the primitive header');
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endprimitive');
      return null;
    }
    try {
      for (;;) {
        const dattrs = this.parseAttrs();
        const t = this.peek();
        if (t.kind === 'keyword' && (t.text === 'input' || t.text === 'output' || t.text === 'reg')) {
          this.next();
          const reg = t.text === 'output' && !!this.eatKw('reg');
          const names: UdpPortDecl['names'] = [];
          for (;;) {
            const n = this.expectIdent(`in the '${t.text}' declaration`);
            const entry: UdpPortDecl['names'][number] = { name: n };
            if (this.eatOp('=')) entry.init = this.parseExpr(0);
            names.push(entry);
            if (!this.eatOp(',')) break;
          }
          this.expectOp(';', `at the end of the '${t.text}' declaration`);
          udp.decls.push(this.withAttrs<UdpPortDecl>({ kind: t.text as 'input', reg, names, span: this.since(t.span) }, dattrs));
        } else break;
      }
      if (this.isKw('initial')) {
        this.next();
        const n = this.expectIdent("after 'initial'");
        this.expectOp('=', 'after the output name');
        const value = this.parseExpr(0);
        this.expectOp(';', "at the end of 'initial'");
        udp.init = { name: n, value };
      }
      this.expectKw('table', "to start the primitive's table");
      let sawSeq: boolean | undefined;
      while (!this.isKw('endtable')) {
        if (this.eof || this.isKw('endprimitive') || this.isKw('endmodule')) {
          this.report('syntax-error', "This 'table' is never closed. Add 'endtable'.", kw.span);
          throw ABORT;
        }
        const entry = this.parseUdpEntry();
        if (entry) {
          const seq = entry.current !== undefined;
          if (sawSeq !== undefined && sawSeq !== seq) this.report('syntax-error', 'A table is either combinational (inputs : output) or sequential (inputs : state : next state), not both.', entry.span);
          sawSeq ??= seq;
          udp.entries.push(entry);
        }
      }
      this.next();
      udp.sequential = sawSeq ?? (udp.init !== undefined || udp.ports.some((p) => p.reg) || udp.decls.some((d) => d.reg || d.kind === 'reg'));
      this.expectKw('endprimitive', "to end the primitive");
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endprimitive');
    }
    udp.span = this.since(kw.span);
    return this.withAttrs(udp, attrs);
  }

  private parseUdpEntry(): UdpEntry | null {
    const start = this.peek();
    let text = '';
    while (!this.eof && !this.isOp(';') && !this.isKw('endtable') && !this.isKw('endprimitive')) {
      text += this.peek().text;
      this.next();
    }
    if (!this.isOp(';')) {
      this.fail(this.peek().span, "Expected ';' at the end of the table row.");
    }
    this.next();
    const span = this.since(start.span);
    const parts = text.split(':');
    const symbols = (s: string): string[] | null => {
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        if (c === '(') {
          const m = /^\(([01xXbB?])([01xXbB?])\)/.exec(s.slice(i));
          if (!m) return null;
          out.push(m[0]);
          i += m[0].length - 1;
        } else if ('01xXbB?rRfFpPnN*'.includes(c)) out.push(c);
        else return null;
      }
      return out;
    };
    const bad = (why: string): null => {
      this.report('syntax-error', why, span);
      return null;
    };
    if (parts.length < 2 || parts.length > 3) return bad("A table row has the form 'inputs : output;' or 'inputs : state : next state;'.");
    const inputs = symbols(parts[0]!);
    if (!inputs || inputs.length === 0) return bad(`'${abbreviate(parts[0]!)}' is not a valid list of input symbols. Use 0 1 x ? b, edges such as (01) or r f p n *.`);
    if (parts.length === 3) {
      const cur = symbols(parts[1]!);
      if (!cur || cur.length !== 1 || cur[0]!.length !== 1 || 'rRfFpPnN*'.includes(cur[0]!)) return bad(`'${abbreviate(parts[1]!)}' is not a valid current state. Use one of 0 1 x ? b.`);
      if (!/^[01xX-]$/.test(parts[2]!)) return bad(`'${abbreviate(parts[2]!)}' is not a valid next state. Use one of 0 1 x -.`);
      return { inputs, current: cur[0]!, next: parts[2]!, span };
    }
    if (!/^[01xX]$/.test(parts[1]!)) return bad(`'${abbreviate(parts[1]!)}' is not a valid output. Use one of 0 1 x.`);
    return { inputs, next: parts[1]!, span };
  }

  // ------------------------------------------------------------ configurations

  private parseCellRef(): CellRef {
    const a = this.expectIdent('for the cell');
    if (this.eatOp('.')) return { lib: a, cell: this.expectIdent("after '.'") };
    return { cell: a };
  }

  private parseLiblist(): Ident[] {
    const out: Ident[] = [];
    while (this.peek().kind === 'ident') out.push(this.expectIdent('for the library'));
    return out;
  }

  private parseUse(): { cell: CellRef; config: boolean } {
    this.expectKw('use', "in the configuration rule");
    const cell = this.parseCellRef();
    let config = false;
    if (this.eatOp(':')) {
      this.expectKw('config', "after ':' in 'use'");
      config = true;
    }
    return { cell, config };
  }

  private parseConfig(attrs: Attribute[] | undefined): ConfigDecl | null {
    const kw = this.next();
    let name: Ident;
    try {
      name = this.expectIdent("after 'config'");
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endconfig');
      return null;
    }
    const cfg: ConfigDecl = { kind: 'config', name, design: [], rules: [], span: kw.span };
    try {
      this.expectOp(';', 'after the configuration name');
      this.expectKw('design', "in the configuration");
      while (this.peek().kind === 'ident') cfg.design.push(this.parseCellRef());
      this.expectOp(';', "after 'design'");
      while (!this.isKw('endconfig')) {
        if (this.eof || this.isKw('endmodule') || this.isKw('module')) {
          this.report('syntax-error', "This 'config' is never closed. Add 'endconfig'.", kw.span);
          throw ABORT;
        }
        const before = this.pos;
        try {
          const rule = this.parseConfigRule();
          cfg.rules.push(rule);
        } catch (e) {
          if (e !== ABORT) throw e;
          this.skipToSemicolon();
          if (this.pos === before) this.next();
        }
      }
      this.next();
    } catch (e) {
      if (e !== ABORT) throw e;
      this.skipThrough('endconfig');
    }
    cfg.span = this.since(kw.span);
    return this.withAttrs(cfg, attrs);
  }

  private skipToSemicolon() {
    while (!this.eof && !this.isOp(';') && !this.isKw('endconfig')) this.next();
    this.eatOp(';');
  }

  private parseConfigRule(): ConfigRule {
    const t = this.peek();
    let rule: ConfigRule;
    if (this.eatKw('default')) {
      this.expectKw('liblist', "after 'default'");
      rule = { kind: 'default', liblist: this.parseLiblist(), span: t.span };
    } else if (this.eatKw('instance')) {
      const path: Ident[] = [this.expectIdent("after 'instance'")];
      while (this.eatOp('.')) path.push(this.expectIdent("after '.'"));
      rule = { kind: 'instance', path, span: t.span };
      if (this.isKw('use')) rule.use = this.parseUse();
      else {
        this.expectKw('liblist', "or 'use' after the instance name");
        rule.liblist = this.parseLiblist();
      }
    } else if (this.eatKw('cell')) {
      const cell = this.parseCellRef();
      rule = { kind: 'cell', cell, span: t.span };
      if (this.isKw('use')) rule.use = this.parseUse();
      else {
        this.expectKw('liblist', "or 'use' after the cell name");
        rule.liblist = this.parseLiblist();
      }
    } else return this.fail(t.span, `Expected 'default', 'instance' or 'cell' in the configuration, but found ${this.describe(t)}.`);
    this.expectOp(';', 'at the end of the configuration rule');
    rule.span = this.since(t.span);
    return rule;
  }

  // ------------------------------------------------------------ file

  parseFile(): SourceFile {
    const units: SourceUnit[] = [];
    while (!this.eof) {
      const attrsStart = this.pos;
      let attrs: Attribute[] | undefined;
      try {
        attrs = this.parseAttrs();
      } catch (e) {
        if (e !== ABORT) throw e;
        while (!this.eof && !this.isTopStart()) this.next();
        continue;
      }
      const t = this.peek();
      if (t.kind === 'keyword' && TOP_START.has(t.text)) {
        let u: SourceUnit | null = null;
        try {
          u = t.text === 'primitive' ? this.parseUdp(attrs) : t.text === 'config' ? this.parseConfig(attrs) : this.parseModule(attrs);
        } catch (e) {
          if (e !== ABORT_MODULE) throw e;
          this.skipThrough(t.text === 'primitive' ? 'endprimitive' : t.text === 'config' ? 'endconfig' : 'endmodule');
        }
        if (u) units.push(u);
      } else {
        this.report('syntax-error', `Expected 'module' at the top level, but found ${this.describe(t)}.`, t.span);
        if (this.pos === attrsStart) this.next();
        while (!this.eof && !this.isTopStart()) this.next();
      }
    }
    return { units, modules: units.filter((u): u is ModuleDecl => u.kind === 'module') };
  }

  private isTopStart(): boolean {
    return this.kwIn(TOP_START) || this.isOp('(*');
  }
}

export function parse(tokens: Token[], sink: DiagnosticSink): SourceFile {
  return new Parser(tokens, sink).parseFile();
}

/** Parse a single expression (for tests and tools). */
export function parseExpression(tokens: Token[], sink: DiagnosticSink): Expr | null {
  const p = new Parser(tokens, sink);
  try {
    return p.parseExpr();
  } catch (e) {
    if (e !== ABORT && e !== ABORT_MODULE) throw e;
    return null;
  }
}

