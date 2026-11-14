import type * as A from '../ast';
import type { NetId } from '../design';
import type { Span } from '../diagnostics';
import type { CVal } from './cval';

/**
 * The names elaboration knows. A module is a tree of scopes (the module, each generate block, each function
 * call, each named block with declarations); a name resolves in its own scope and then outward.
 */

export type NetKindIR = 'wire' | 'wand' | 'wor' | 'pull0' | 'pull1' | 'supply0' | 'supply1';

/** A memory (`reg [7:0] m [0:15]`): the words live in one `memory` cell built after the whole module is read. */
export interface Mem {
  width: number;
  depth: number;
  /** Declared bounds of the address range, `[first:last]` as written. */
  first: number;
  last: number;
  /** Lowest address, which is word 0. */
  base: number;
  readPorts: { addr: NetId; data: NetId; clk?: NetId; edge?: 'pos' | 'neg' }[];
  writePorts: { addr: NetId; data: NetId; en: NetId; clk: NetId; edge: 'pos' | 'neg' }[];
  init?: string[];
  cellName: string;
}

/**
 * A signal or variable: a wire, a reg, an integer, or a local of a function or task. Locals have no net; they
 * exist only while a call is being expanded.
 */
export interface Var {
  kind: 'var';
  /** Hierarchical name inside the module, such as `gen[2].x`. */
  name: string;
  type: 'wire' | 'reg' | 'integer' | 'time';
  netKind: NetKindIR;
  width: number;
  signed: boolean;
  /** Declared bounds: bit `msb` is the most significant, `lsb` the least. Either may be larger. */
  msb: number;
  lsb: number;
  /** Declared without a range, so it has no bits to select. */
  scalar: boolean;
  net: NetId;
  isLocal: boolean;
  mem?: Mem;
  port?: 'input' | 'output' | 'inout';
  /** A port declared `reg` (or any reg/integer declaration), i.e. one that procedural code assigns. */
  isVariable: boolean;
  span: Span;
  /** The name is mentioned in an expression (for the unused-signal lint). */
  mentioned: boolean;
  /** The net of this signal is consulted as a source (decides whether a temporary needs hardware). */
  netRead: boolean;
  blockingWrites: number;
  nonblockingWrites: number;
  /** Assigned in the header or by `wire w = e;`. */
  declInit: boolean;
  /** Power-on value of a reg (MSB first over '0' '1' 'x', `width` bits) from `reg q = 5;` or an `initial` block. */
  init?: string;
  /** Declared with `integer` or used as a procedural loop variable: nothing is built for it unless it is read. */
  scratch: boolean;
  /** Bits that float to 0 or 1 when nothing drives them: `tri0`, `tri1`, `pullup`, `pulldown`. */
  pulls: { lo: number; width: number; kind: NetKindIR }[];
}

export interface Param {
  kind: 'param';
  name: string;
  value: CVal;
  span: Span;
  /** Declared with a type or a range, so the value was cast to it. */
  local: boolean;
}

export interface Genvar {
  kind: 'genvar';
  name: string;
  value?: CVal;
}

export interface FuncEntry {
  kind: 'func';
  decl: A.FunctionDecl;
  scope: Scope;
}

export interface TaskEntry {
  kind: 'task';
  decl: A.TaskDecl;
  scope: Scope;
}

export interface InstName {
  kind: 'inst';
  span: Span;
}

export interface ScopeEntry {
  kind: 'scope';
  scope: Scope;
}

export type Entry = Var | Param | Genvar | FuncEntry | TaskEntry | InstName | ScopeEntry;

export class Scope {
  readonly syms = new Map<string, Entry>();
  /** Child scopes by name, with `[i]` appended for generate-for iterations. */
  readonly children = new Map<string, Scope>();
  readonly types = new Map<A.Expr, { w: number; s: boolean }>();
  /** Counter for implicit generate block names (`genblk1`, ...). */
  genBlocks = 0;
  constructor(
    readonly kind: 'module' | 'gen' | 'block' | 'func' | 'task',
    /** Prefix for the names declared here: '' for the module, `gen[2].` for an iteration. */
    readonly prefix: string,
    readonly parent?: Scope,
  ) {}

  lookup(name: string): Entry | undefined {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const e = s.syms.get(name);
      if (e) return e;
    }
    return undefined;
  }

  lookupLocal(name: string): Entry | undefined {
    return this.syms.get(name);
  }

  moduleScope(): Scope {
    let s: Scope = this;
    while (s.parent) s = s.parent;
    return s;
  }
}
