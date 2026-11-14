import type { Span } from './diagnostics';

/**
 * Abstract syntax tree for the whole Verilog-2005 design language (IEEE 1364-2005 annex A).
 *
 * The tree records what the source says and nothing about what it means, so it is the same however much of the
 * language elaboration understands. Parentheses are not nodes: precedence is in the shape of the tree. Lists
 * that Verilog lets several names share (`wire a, b;`, `assign x = 1, y = 2;`, `and g1 (...), g2 (...);`, a
 * `parameter` list, a port list that repeats its direction) are written out one node per name or per
 * assignment wherever the sharing has no effect on meaning, so the printer can write them again in any form
 * and get the same tree back.
 */

export interface Ident {
  kind: 'ident';
  name: string;
  span: Span;
}

/** `(* name = value, other *)` as one flat list: several `(* *)` groups in a row are one list. */
export interface Attribute {
  name: Ident;
  value?: Expr;
  span: Span;
}

export interface Attributed {
  attrs?: Attribute[];
}

// ---------------------------------------------------------------- expressions

/** One segment of a hierarchical name: `g[2]` in `top.g[2].x`. */
export interface HierSegment {
  name: Ident;
  /** A constant index selecting one scope of a generate array. */
  index?: Expr;
}

/** A hierarchical name with at least two segments, such as `top.u1.x`. */
export interface HierRef {
  kind: 'hier';
  segments: HierSegment[];
  /** The segment names joined with '.', for messages. */
  name: string;
  span: Span;
}

export type Ref = Ident | HierRef;

/** An integer literal, as written (`8'sh7F`, `'b1`, `12`). */
export interface NumberExpr {
  kind: 'number';
  text: string;
  span: Span;
}

/** A real literal, as written (`1.5`, `1e3`). */
export interface RealExpr {
  kind: 'real';
  text: string;
  span: Span;
}

/** A string literal as written, with its quotes. */
export interface StringExpr {
  kind: 'string';
  text: string;
  span: Span;
}

/**
 * `a[i]`, `a[hi:lo]`, `a[base+:width]`, `a[base-:width]`, and with several dimensions `m[i][j][hi:lo]`: `dims`
 * holds every index but the last, `hi`/`lo`/`mode` the last select.
 */
export interface IndexExpr {
  kind: 'index';
  base: Ref;
  dims: Expr[];
  hi: Expr;
  lo?: Expr;
  mode: 'bit' | 'range' | 'plus' | 'minus';
  span: Span;
}

export interface ConcatExpr {
  kind: 'concat';
  /** Most significant first, as written. */
  parts: Expr[];
  span: Span;
}

/** `{n{a, b}}`. */
export interface ReplicateExpr {
  kind: 'replicate';
  count: Expr;
  inner: ConcatExpr;
  span: Span;
}

export interface UnaryExpr extends Attributed {
  kind: 'unary';
  op: string;
  operand: Expr;
  span: Span;
}

export interface BinaryExpr extends Attributed {
  kind: 'binary';
  op: string;
  lhs: Expr;
  rhs: Expr;
  span: Span;
}

export interface TernaryExpr extends Attributed {
  kind: 'ternary';
  cond: Expr;
  then: Expr;
  else: Expr;
  span: Span;
}

/** `(min : typ : max)`. */
export interface MinTypMaxExpr {
  kind: 'mintypmax';
  min: Expr;
  typ: Expr;
  max: Expr;
  span: Span;
}

/** A call of a user function. */
export interface CallExpr extends Attributed {
  kind: 'call';
  callee: Ref;
  args: Expr[];
  span: Span;
}

/** A call of a system function such as `$clog2(n)` or `$time`. */
export interface SysCallExpr {
  kind: 'syscall';
  /** With its `$`. */
  name: string;
  args: Expr[];
  /** Written with parentheses, as in `$time()`. */
  parens: boolean;
  span: Span;
}

export type Expr =
  | Ident
  | HierRef
  | NumberExpr
  | RealExpr
  | StringExpr
  | IndexExpr
  | ConcatExpr
  | ReplicateExpr
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | MinTypMaxExpr
  | CallExpr
  | SysCallExpr;

/** `#1`, `#(1, 2)`, `#(1:2:3, 4)`: one to three delays (more in a specify block). */
export interface DelayList {
  values: Expr[];
  span: Span;
}

export interface RangeSpec {
  msb: Expr;
  lsb: Expr;
  span: Span;
}

// ---------------------------------------------------------------- timing controls and statements

export interface DelayControl {
  kind: 'delay';
  delay: DelayList;
  span: Span;
}

export interface EventTerm {
  edge: 'pos' | 'neg' | 'level';
  expr: Expr;
}

/** `@(a or posedge b, c)`, `@name`, or `@*`. */
export interface EventControl {
  kind: 'event';
  /** `'star'` for `@*`, `@(*)`. */
  events: EventTerm[] | 'star';
  span: Span;
}

/** `repeat (n) @(e)` after the `=` of an intra-assignment. */
export interface RepeatEventControl {
  kind: 'repeatEvent';
  count: Expr;
  event: EventControl;
  span: Span;
}

export type TimingControl = DelayControl | EventControl | RepeatEventControl;

export interface BlockStmt extends Attributed {
  kind: 'block';
  stmts: Stmt[];
  /** `fork ... join` when true, `begin ... end` otherwise. */
  parallel: boolean;
  name?: Ident;
  /** Declarations that follow `begin : name`. */
  decls: BlockDecl[];
  span: Span;
}

export interface IfStmt extends Attributed {
  kind: 'if';
  cond: Expr;
  then: Stmt;
  else?: Stmt;
  span: Span;
}

export interface AssignStmt extends Attributed {
  kind: 'assign';
  lhs: Expr;
  rhs: Expr;
  /** `=` (true) or `<=` (false). */
  blocking: boolean;
  /** An intra-assignment delay or event control: `a = #5 b`, `q <= @(posedge c) d`. */
  control?: TimingControl;
  span: Span;
}

export interface EmptyStmt extends Attributed {
  kind: 'empty';
  span: Span;
}

export interface CaseItem {
  /** Absent for `default`. */
  labels?: Expr[];
  body: Stmt;
  span: Span;
}

export interface CaseStmt extends Attributed {
  kind: 'case';
  flavor: 'case' | 'casex' | 'casez';
  expr: Expr;
  items: CaseItem[];
  span: Span;
}

/** `lhs = rhs` inside a `for (...)` header. */
export interface LoopAssign {
  lhs: Expr;
  rhs: Expr;
  span: Span;
}

export interface ForStmt extends Attributed {
  kind: 'for';
  init: LoopAssign;
  cond: Expr;
  step: LoopAssign;
  body: Stmt;
  span: Span;
}

export interface WhileStmt extends Attributed {
  kind: 'while';
  cond: Expr;
  body: Stmt;
  span: Span;
}

export interface RepeatStmt extends Attributed {
  kind: 'repeat';
  count: Expr;
  body: Stmt;
  span: Span;
}

export interface ForeverStmt extends Attributed {
  kind: 'forever';
  body: Stmt;
  span: Span;
}

/** `#5 stmt`, `@(posedge clk) stmt`; the statement may be empty. */
export interface TimingStmt extends Attributed {
  kind: 'timing';
  control: DelayControl | EventControl;
  body: Stmt;
  span: Span;
}

export interface WaitStmt extends Attributed {
  kind: 'wait';
  cond: Expr;
  body: Stmt;
  span: Span;
}

/** `-> ev;` */
export interface TriggerStmt extends Attributed {
  kind: 'trigger';
  event: Expr;
  span: Span;
}

export interface DisableStmt extends Attributed {
  kind: 'disable';
  target: Ref;
  span: Span;
}

/** Procedural continuous assignment: `assign`, `deassign`, `force`, `release`. */
export interface ProcAssignStmt extends Attributed {
  kind: 'procAssign';
  op: 'assign' | 'deassign' | 'force' | 'release';
  lhs: Expr;
  /** Absent for `deassign` and `release`. */
  rhs?: Expr;
  span: Span;
}

/** A call of a user task: `t;` or `t(a, b);`. */
export interface TaskCallStmt extends Attributed {
  kind: 'taskCall';
  callee: Ref;
  args: Expr[];
  parens: boolean;
  span: Span;
}

/** A call of a system task such as `$display("x", a);`. An argument may be left out: `$display(, a)` has `null` first. */
export interface SysTaskStmt extends Attributed {
  kind: 'sysTask';
  name: string;
  args: (Expr | null)[];
  parens: boolean;
  span: Span;
}

export type Stmt =
  | BlockStmt
  | IfStmt
  | AssignStmt
  | EmptyStmt
  | CaseStmt
  | ForStmt
  | WhileStmt
  | RepeatStmt
  | ForeverStmt
  | TimingStmt
  | WaitStmt
  | TriggerStmt
  | DisableStmt
  | ProcAssignStmt
  | TaskCallStmt
  | SysTaskStmt;

// ---------------------------------------------------------------- declarations

export type NetKind =
  | 'wire'
  | 'tri'
  | 'tri0'
  | 'tri1'
  | 'triand'
  | 'trior'
  | 'trireg'
  | 'wand'
  | 'wor'
  | 'supply0'
  | 'supply1'
  | 'uwire'
  | 'reg'
  | 'integer'
  | 'real'
  | 'realtime'
  | 'time'
  | 'event';

export type Strength0 = 'supply0' | 'strong0' | 'pull0' | 'weak0' | 'highz0';
export type Strength1 = 'supply1' | 'strong1' | 'pull1' | 'weak1' | 'highz1';
export type ChargeStrength = 'small' | 'medium' | 'large';

/** `(strong0, pull1)`, as written: `first` is whichever of the two came first. A pull gate has just one. */
export interface DriveStrength {
  first: Strength0 | Strength1;
  /** Absent for the single strength of `pullup (pull1) p (y)`. */
  second?: Strength0 | Strength1;
}

/** A name being declared: with array dimensions (`mem [0:7]`) or an initial value (`w = a & b`, `r = 0`). */
export interface Declarator {
  name: Ident;
  /** Array dimensions, outermost first. */
  dims: RangeSpec[];
  init?: Expr;
  span: Span;
}

/** `wire`, `tri`, ..., `reg`, `integer`, `real`, `time`, `realtime`, `event`. */
export interface NetDecl extends Attributed {
  kind: 'netDecl';
  net: NetKind;
  signed: boolean;
  vectored?: 'vectored' | 'scalared';
  range?: RangeSpec;
  drive?: DriveStrength;
  charge?: ChargeStrength;
  delay?: DelayList;
  declarators: Declarator[];
  span: Span;
}

/** One assignment of a `parameter` or `localparam`, or of a `specparam` (whose value may be a pulse limit pair). */
export interface ParamDecl extends Attributed {
  kind: 'paramDecl';
  local: boolean;
  /** `integer`, `real`, `realtime` or `time` when written. */
  type?: 'integer' | 'real' | 'realtime' | 'time';
  signed: boolean;
  range?: RangeSpec;
  /** One entry per `name = value`; a port list `parameter` has exactly one. */
  assigns: ParamAssign[];
  span: Span;
}

export interface ParamAssign {
  name: Ident;
  value: Expr;
  span: Span;
}

export interface SpecparamDecl extends Attributed {
  kind: 'specparamDecl';
  range?: RangeSpec;
  assigns: { name: Ident; value: Expr | DelayList; span: Span }[];
  span: Span;
}

export interface GenvarDecl extends Attributed {
  kind: 'genvarDecl';
  names: Ident[];
  span: Span;
}

export interface DefparamItem extends Attributed {
  kind: 'defparam';
  assigns: { target: Ref; value: Expr; span: Span }[];
  span: Span;
}

/** A port declared in the body of a module, function or task (`input [3:0] a, b;`), or in a UDP. */
export interface PortDeclItem extends Attributed {
  kind: 'portDecl';
  dir: 'input' | 'output' | 'inout';
  net?: NetKind;
  signed: boolean;
  range?: RangeSpec;
  names: { name: Ident; init?: Expr }[];
  span: Span;
}

export type BlockDecl = NetDecl | ParamDecl | PortDeclItem;

// ---------------------------------------------------------------- module items

export interface ContinuousAssign extends Attributed {
  kind: 'continuousAssign';
  lhs: Expr;
  rhs: Expr;
  drive?: DriveStrength;
  delay?: DelayList;
  span: Span;
}

export interface AlwaysBlock extends Attributed {
  kind: 'always';
  /**
   * The event control that starts the block, when it has one: `always @(posedge clk) body` has the event
   * list here and the body in `body`. `always #5 x = ~x;` has no event list and its whole statement in `body`.
   */
  events?: EventTerm[] | 'star';
  body: Stmt;
  span: Span;
}

export interface InitialBlock extends Attributed {
  kind: 'initial';
  body: Stmt;
  span: Span;
}

export interface Connection extends Attributed {
  port: Ident;
  /** Absent for `.p()`. */
  expr?: Expr;
  span: Span;
}

/** A positional connection; `expr` is absent for an empty slot, as in `(a, , b)`. */
export interface OrderedConnection extends Attributed {
  expr?: Expr;
  span: Span;
}

export interface NamedParamValue {
  name: Ident;
  /** Absent for `.P()`. */
  value?: Expr;
  span: Span;
}

export type ParamOverrides = { style: 'named'; items: NamedParamValue[] } | { style: 'ordered'; items: Expr[] };

/** An instance of a module or of a user-defined primitive (which the syntax cannot tell apart). */
export interface Instance extends Attributed {
  kind: 'instance';
  module: Ident;
  /** `#(...)` after the module name. */
  params?: ParamOverrides;
  /** A drive strength after the name, which only a UDP instance has. */
  drive?: DriveStrength;
  /** Absent for an unnamed (UDP) instance. */
  name?: Ident;
  /** `u[3:0]` after the instance name. */
  range?: RangeSpec;
  /** Named connections. Empty when `ordered` is present. */
  conns: Connection[];
  /** Positional connections, when the instance uses them. */
  ordered?: OrderedConnection[];
  span: Span;
}

export type GateKind =
  | 'and'
  | 'nand'
  | 'or'
  | 'nor'
  | 'xor'
  | 'xnor'
  | 'buf'
  | 'not'
  | 'bufif0'
  | 'bufif1'
  | 'notif0'
  | 'notif1'
  | 'nmos'
  | 'pmos'
  | 'rnmos'
  | 'rpmos'
  | 'cmos'
  | 'rcmos'
  | 'tran'
  | 'rtran'
  | 'tranif0'
  | 'tranif1'
  | 'rtranif0'
  | 'rtranif1'
  | 'pullup'
  | 'pulldown';

/** One gate or switch instance. */
export interface GateInst extends Attributed {
  kind: 'gate';
  gate: GateKind;
  drive?: DriveStrength;
  /** Pulls take a strength only, so for them this is absent. */
  delay?: DelayList;
  name?: Ident;
  range?: RangeSpec;
  /** Output (or inout) terminals first, then the inputs. */
  terminals: Expr[];
  span: Span;
}

export interface GenerateRegion extends Attributed {
  kind: 'generateRegion';
  items: ModuleItem[];
  span: Span;
}

/** The body of a generate `for`, `if` or `case`: a single item, or `begin [: name] ... end`. */
export interface GenerateBlock {
  /** Written with `begin`/`end`, or a bare item that stands for several. A bare item, or `;`, has `explicit` false and at most one item. */
  explicit: boolean;
  name?: Ident;
  items: ModuleItem[];
  span: Span;
}

export interface GenerateFor extends Attributed {
  kind: 'generateFor';
  init: { genvar: Ident; value: Expr };
  cond: Expr;
  step: { genvar: Ident; value: Expr };
  body: GenerateBlock;
  span: Span;
}

export interface GenerateIf extends Attributed {
  kind: 'generateIf';
  cond: Expr;
  then: GenerateBlock;
  else?: GenerateBlock;
  span: Span;
}

export interface GenerateCaseItem {
  /** Absent for `default`. */
  labels?: Expr[];
  body: GenerateBlock;
  span: Span;
}

export interface GenerateCase extends Attributed {
  kind: 'generateCase';
  expr: Expr;
  items: GenerateCaseItem[];
  span: Span;
}

/** `function` or `task` port, written in the header (ANSI style): one per name. */
export interface TfPort extends Attributed {
  dir: 'input' | 'output' | 'inout';
  net?: NetKind;
  signed: boolean;
  range?: RangeSpec;
  name: Ident;
  span: Span;
}

export interface FunctionDecl extends Attributed {
  kind: 'function';
  automatic: boolean;
  signed: boolean;
  /** The result: a range (after an optional `reg`), or one of the variable types. Neither means a 1-bit result. */
  range?: RangeSpec;
  type?: 'integer' | 'real' | 'realtime' | 'time' | 'reg';
  name: Ident;
  /** Header ports. Empty both for `function f;` and for old-style `input` declarations in the body. */
  ports: TfPort[];
  /** Whether the header has a parenthesised port list. */
  ansi: boolean;
  decls: BlockDecl[];
  body: Stmt;
  span: Span;
}

export interface TaskDecl extends Attributed {
  kind: 'task';
  automatic: boolean;
  name: Ident;
  ports: TfPort[];
  ansi: boolean;
  decls: BlockDecl[];
  body: Stmt;
  span: Span;
}

// ---------------------------------------------------------------- specify blocks

/** A timing check argument: `posedge clk &&& en`, or any expression. `null` in the list is an omitted argument. */
export interface TimingArg {
  /** `edge [01, 10]` is `'edge'` with its descriptors in `descriptors`. */
  edge?: 'posedge' | 'negedge' | 'edge';
  descriptors?: string[];
  expr: Expr;
  /** The condition after `&&&`. */
  cond?: Expr;
  span: Span;
}

export interface TimingCheck {
  kind: 'timingCheck';
  /** With its `$`, as in `$setup`. */
  name: string;
  args: (TimingArg | null)[];
  span: Span;
}

/** `(a, b +=> c) = 1;`, `if (en) (posedge clk => (q : d)) = (1, 2);`. */
export interface PathDecl {
  kind: 'path';
  /** `if (expr)`, or the `ifnone` keyword. */
  cond?: { kind: 'if'; expr: Expr } | { kind: 'ifnone' };
  /** An edge-sensitive path: `posedge` or `negedge` before the inputs. */
  edge?: 'posedge' | 'negedge';
  inputs: Expr[];
  /** Polarity written after the inputs. */
  inPolarity?: '+' | '-';
  /** `=>` (parallel) or `*>` (full). */
  connection: '=>' | '*>';
  outputs: Expr[];
  outPolarity?: '+' | '-';
  /** `(q : d)`: the data source of an edge-sensitive path. */
  dataSource?: Expr;
  delays: Expr[];
  span: Span;
}

export interface PulseStyleDecl {
  kind: 'pulseStyle';
  style: 'pulsestyle_onevent' | 'pulsestyle_ondetect' | 'showcancelled' | 'noshowcancelled';
  outputs: Expr[];
  span: Span;
}

export type SpecifyItem = SpecparamDecl | PathDecl | TimingCheck | PulseStyleDecl;

export interface SpecifyBlock extends Attributed {
  kind: 'specify';
  items: SpecifyItem[];
  span: Span;
}

// ---------------------------------------------------------------- module declarations

export type ModuleItem =
  | NetDecl
  | ParamDecl
  | SpecparamDecl
  | GenvarDecl
  | DefparamItem
  | PortDeclItem
  | ContinuousAssign
  | AlwaysBlock
  | InitialBlock
  | Instance
  | GateInst
  | GenerateRegion
  | GenerateFor
  | GenerateIf
  | GenerateCase
  | FunctionDecl
  | TaskDecl
  | SpecifyBlock;

/** A port declared in the module header (ANSI style), one per name. */
export interface PortDecl extends Attributed {
  dir: 'input' | 'output' | 'inout';
  /** `wire`, `reg`, ... when written. */
  net?: NetKind;
  signed: boolean;
  range?: RangeSpec;
  name: Ident;
  init?: Expr;
  span: Span;
}

/** A name used in a non-ANSI port expression: `a`, `a[3]`, `a[7:4]`. */
export interface PortRef {
  name: Ident;
  select?: { hi: Expr; lo?: Expr; mode: 'bit' | 'range' | 'plus' | 'minus' };
  span: Span;
}

/** One port of a non-ANSI header: `a`, `.p(a[3:0])`, `{a, b}`, or an empty slot. */
export interface NonAnsiPort {
  /** The external name of `.p(...)`. */
  external?: Ident;
  /** Empty for a slot with no port expression. A concatenation lists several. */
  refs: PortRef[];
  /** Written as `{a, b}`. */
  braced: boolean;
  span: Span;
}

export interface ModuleDecl extends Attributed {
  kind: 'module';
  name: Ident;
  /** `macromodule` rather than `module`. */
  macro: boolean;
  /** `#(parameter ...)`, one assignment per entry. */
  paramPorts?: ParamDecl[];
  /** No parentheses at all, an ANSI list (possibly empty), or a non-ANSI list. */
  portStyle: 'none' | 'ansi' | 'nonansi';
  /** The ANSI ports; empty unless `portStyle` is 'ansi'. */
  ports: PortDecl[];
  /** The non-ANSI port list; empty unless `portStyle` is 'nonansi'. */
  portList: NonAnsiPort[];
  items: ModuleItem[];
  span: Span;
}

// ---------------------------------------------------------------- user-defined primitives

export interface UdpPort {
  dir: 'input' | 'output';
  /** `output reg`. */
  reg: boolean;
  name: Ident;
  init?: Expr;
  span: Span;
}

/** A port declaration in the body of a UDP with a plain port-name list. */
export interface UdpPortDecl extends Attributed {
  kind: 'input' | 'output' | 'reg';
  /** `output reg`. */
  reg: boolean;
  names: { name: Ident; init?: Expr }[];
  span: Span;
}

/** One table row. Each input is a level symbol (`0 1 x ? b`), an edge symbol (`r f p n *`) or a pair such as `(01)`. */
export interface UdpEntry {
  inputs: string[];
  /** The current state of a sequential row. */
  current?: string;
  /** The output (combinational) or next state (sequential), `-` for no change. */
  next: string;
  span: Span;
}

export interface UdpDecl extends Attributed {
  kind: 'udp';
  name: Ident;
  /** Ports declared in the header: output first. */
  ports: UdpPort[];
  /** Names of a plain header; the body then declares them. */
  names: Ident[];
  ansi: boolean;
  decls: UdpPortDecl[];
  sequential: boolean;
  /** `initial q = 0;` */
  init?: { name: Ident; value: Expr };
  entries: UdpEntry[];
  span: Span;
}

// ---------------------------------------------------------------- configurations

/** `lib.cell` or just `cell`. */
export interface CellRef {
  lib?: Ident;
  cell: Ident;
}

export type ConfigRule =
  | { kind: 'default'; liblist: Ident[]; span: Span }
  | { kind: 'instance'; path: Ident[]; use?: { cell: CellRef; config: boolean }; liblist?: Ident[]; span: Span }
  | { kind: 'cell'; cell: CellRef; use?: { cell: CellRef; config: boolean }; liblist?: Ident[]; span: Span };

export interface ConfigDecl extends Attributed {
  kind: 'config';
  name: Ident;
  design: CellRef[];
  rules: ConfigRule[];
  span: Span;
}

export type SourceUnit = ModuleDecl | UdpDecl | ConfigDecl;

export interface SourceFile {
  /** Everything declared, in source order. */
  units: SourceUnit[];
  /** The module declarations of `units`, for convenience. */
  modules: ModuleDecl[];
}
