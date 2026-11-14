import type * as A from '../ast';
import { type Cell, type Module, type NetId, cellInputs } from '../design';
import { type DiagnosticCode, DiagnosticSink, type Span } from '../diagnostics';
import { Consts, NotConstant, bitPos, newStore } from './consteval';
import * as cv from './cval';
import type { CVal } from './cval';
import { Lowerer } from './expr';
import { type CombSummary, findCombLoops, lvalueName, sigWidth, summarize } from './lint';
import { Netlist, type Word } from './netlist';
import { Proc, type ProcOut } from './proc';
import { type FuncEntry, type Genvar, type Mem, type NetKindIR, Scope, type Var } from './scope';

/**
 * One module under elaboration: a parameter binding of a module declaration, turned into a Module of the IR.
 * It owns the symbol tables and the netlist, and walks the module's items: declarations, assignments, instances,
 * gates, generate constructs, and (through `Proc`) always blocks.
 */

export class ElabAbort extends Error {}
export const ABORT = new ElabAbort();

export interface PortSig {
  name: string;
  dir: 'in' | 'out';
  width: number;
  signed: boolean;
  /** The declaration was rejected; connections to it are skipped without a diagnostic. */
  bad?: boolean;
}

export interface ModuleResult {
  irName: string;
  module: Module;
  ports: PortSig[];
  callees: string[];
  comb: CombSummary;
  broken: boolean;
}

export interface Override {
  value: CVal;
  span: Span;
}

export interface Hier {
  decl(name: string): A.ModuleDecl | undefined;
  isPrimitive(name: string): boolean;
  paramNames(decl: A.ModuleDecl): string[];
  instantiate(name: string, overrides: Map<string, Override>, span: Span): ModuleResult | undefined;
}

export interface ModuleOptions {
  files: Record<string, string>;
  /** The `default_nettype in force where the module starts: 'wire' or 'none' (or another net type name). */
  nettype: string;
  broken: boolean;
}

/** What drives bits [lo, lo+width) of a signal: one net, or tri-state arms that share the bits. */
interface Frag {
  lo: number;
  width: number;
  net?: NetId;
  arms?: { a: NetId; en: NetId }[];
  proc: boolean;
  what: string;
  span: Span;
}

const MAX_GEN = 16384;
const MAX_DEPTH_GEN = 64;

const NET_KIND: Record<string, NetKindIR> = {
  wire: 'wire',
  tri: 'wire',
  uwire: 'wire',
  tri0: 'pull0',
  tri1: 'pull1',
  wand: 'wand',
  triand: 'wand',
  wor: 'wor',
  trior: 'wor',
  supply0: 'supply0',
  supply1: 'supply1',
};

const nameOf = (r: A.Ref) => r.name;

export class ModuleElab {
  readonly sink = new DiagnosticSink();
  readonly nl: Netlist;
  readonly consts: Consts;
  readonly low: Lowerer;
  readonly proc: Proc;
  readonly root = new Scope('module', '');
  scope: Scope = this.root;

  readonly outs: ProcOut[] = [];
  readonly ifConditions: { net: NetId; span: Span }[] = [];
  readonly clockUses: { net: NetId; name: string; span: Span }[] = [];
  readonly vars: Var[] = [];
  private readonly bad = new Set<Var>();
  private readonly frags = new Map<Var, Frag[]>();
  private readonly lateDecls = new Map<string, Span>();
  private readonly callees: string[] = [];
  private errors = 0;
  private readonly consumed = new Set<A.Declarator>();
  private readonly donePorts = new Set<A.PortDeclItem>();
  private readonly doneParams = new Set<A.ParamDecl>();
  private readonly defparams = new Map<string, Map<string, { expr: A.Expr; scope: Scope; span: Span }>>();
  private readonly dffVars: Var[] = [];
  private genDepth = 0;
  private inParams = false;
  private readonly signalNames = new Set<string>();

  readonly ports: { name: string; dir: 'input' | 'output' | 'inout'; v: Var; bad: boolean }[] = [];
  key = '';
  irName = '';

  constructor(
    readonly decl: A.ModuleDecl,
    private readonly overrides: Map<string, Override>,
    private readonly hier: Hier,
    readonly opts: ModuleOptions,
  ) {
    this.nl = new Netlist(decl.span);
    this.consts = new Consts(
      {
        fail: (c, m, s) => this.fail(c, m, s),
        warn: (c, m, s) => this.warn(c, m, s),
        undeclared: (n, s) => this.undeclared(n, s),
      },
      opts.files,
    );
    this.low = new Lowerer(this);
    this.proc = new Proc(this);
  }

  // ------------------------------------------------------------ diagnostics

  error(code: DiagnosticCode, message: string, span: Span) {
    this.errors++;
    this.sink.error(code, message, span);
  }
  fail(code: DiagnosticCode, message: string, span: Span): never {
    this.error(code, message, span);
    throw ABORT;
  }
  warn(code: DiagnosticCode, message: string, span: Span) {
    this.sink.warning(code, message, span);
  }
  private undeclared(name: string, span: Span): never {
    if (this.inParams && this.signalNames.has(name)) {
      this.fail('not-constant', `A parameter value must be a constant expression, but '${name}' is a signal. Build it from numbers and other parameters.`, span);
    }
    const later = this.lateDecls.get(name);
    if (later) this.fail('use-before-declaration', `'${name}' is used before it is declared on line ${later.line}. Move the declaration above its first use.`, span);
    return this.fail('undeclared', `'${name}' is not declared. Declare it as a wire or reg, or check the spelling.`, span);
  }
  private guarded(f: () => void) {
    try {
      f();
    } catch (e) {
      if (e !== ABORT) throw e;
    }
  }

  // ------------------------------------------------------------ ExprHost and ProcHost

  readVar(v: Var): Word {
    return this.proc.read(v);
  }

  mention(v: Var) {
    if (this.bad.has(v)) throw ABORT;
    v.mentioned = true;
  }

  callFunction(f: FuncEntry, e: A.CallExpr): Word {
    return this.proc.callFunction(f, e);
  }

  readMemWord(v: Var, addr: Word, addrSigned: boolean, constAddr: boolean, span: Span): Word {
    const mem = v.mem!;
    const k = this.low.constInt(addr);
    if (k !== undefined) {
      const idx = Number(addrSigned && this.nl.wconstBits(addr)![0] === '1' ? k - (1n << BigInt(addr.w)) : k);
      const word = idx - mem.base;
      if (word < 0 || word >= mem.depth) {
        if (constAddr) this.fail('bad-select', `Word ${idx} is outside the memory '${v.name}', which has words ${mem.first} to ${mem.last}.`, span);
        return this.nl.wconst('x'.repeat(mem.width));
      }
    }
    const a = this.proc.memAddress(v, addr, addrSigned);
    const hit = mem.readPorts.find((p) => p.addr === a);
    let data = hit?.data;
    if (data === undefined) {
      data = this.nl.newNet(mem.width);
      mem.readPorts.push({ addr: a, data });
    }
    return this.proc.shadowRead(mem, a, this.nl.wordOf(data));
  }

  resolveVar(e: A.Ident | A.HierRef): Var {
    const x = this.consts.resolve(e, this.scope);
    if (!x) this.undeclared(nameOf(e), e.span);
    if (x.kind !== 'var') this.fail('bad-assignment', `'${nameOf(e)}' is not a signal, so it cannot be assigned.`, e.span);
    if (this.bad.has(x)) throw ABORT;
    return x;
  }

  lintTruncation(lhsWidth: number, rhs: A.Expr, span: Span, target: string) {
    if (rhs.kind === 'number') return;
    const sig = sigWidth(rhs, this.scope, this.consts);
    if (sig > lhsWidth) {
      this.warn('width-truncation', `Assigning to '${target}' keeps ${lhsWidth} bit${lhsWidth === 1 ? '' : 's'} of a ${sig}-bit value, so the upper bits are lost. Make '${target}' wider, or cut the value explicitly (for example with a part-select) to show it is intended.`, span);
    }
  }

  // ------------------------------------------------------------ declarations

  private rangeInfo(r: A.RangeSpec, what: string): { msb: number; lsb: number; width: number } {
    const msb = this.consts.evalInt(r.msb, this.scope, 'A range bound');
    const lsb = this.consts.evalInt(r.lsb, this.scope, 'A range bound');
    const width = Math.abs(msb - lsb) + 1;
    if (width > 32) this.fail('width-limit', `${what} would be ${width} bits wide; at most 32 bits are supported.`, r.span);
    return { msb, lsb, width };
  }

  private declareVar(
    scope: Scope,
    name: A.Ident,
    o: { type: Var['type']; netKind?: NetKindIR; width: number; signed: boolean; msb: number; lsb: number; scalar: boolean; isVariable: boolean; port?: Var['port']; mem?: Mem; bad?: boolean },
  ): Var | undefined {
    const prev = scope.syms.get(name.name);
    if (prev) {
      const line = 'span' in prev ? prev.span.line : name.span.line;
      this.error('redeclared', `'${name.name}' is already declared on line ${line}.`, name.span);
      return undefined;
    }
    const flat = scope.prefix + name.name;
    const v: Var = {
      kind: 'var', name: flat, type: o.type, netKind: o.netKind ?? 'wire', width: o.width, signed: o.signed, msb: o.msb, lsb: o.lsb, scalar: o.scalar,
      net: o.mem ? -1 : this.nl.newNet(o.width, [flat]), isLocal: false, isVariable: o.isVariable, span: name.span, mentioned: false, netRead: false,
      blockingWrites: 0, nonblockingWrites: 0, declInit: false, scratch: o.type === 'integer', pulls: [],
    };
    if (o.mem) v.mem = o.mem;
    if (o.port) v.port = o.port;
    if (v.netKind !== 'wire' && !o.mem) this.nl.setKind(v.net, v.netKind);
    if ((v.netKind === 'pull0' || v.netKind === 'pull1') && !o.mem) v.pulls.push({ lo: 0, width: v.width, kind: v.netKind });
    scope.syms.set(name.name, v);
    this.vars.push(v);
    if (o.bad) this.bad.add(v);
    return v;
  }

  /** `reg [3:0] a, b;`, `wire w = a & b;`, `integer i;`, `reg [7:0] mem [0:15];`. */
  private declareNets(d: A.NetDecl, scope: Scope) {
    if (d.delay) this.warn('ignored', 'A delay on a declaration has no effect in hardware, so it is ignored.', d.delay.span);
    const net = d.net;
    if (net === 'real' || net === 'realtime') this.fail('not-supported', `'${net}' declarations are not supported yet: real numbers have no hardware form here.`, d.span);
    if (net === 'event') this.fail('not-synthesizable', "An 'event' declaration is not synthesizable; a testbench feature (coming with the simulator).", d.span);
    if (net === 'trireg') this.fail('not-supported', "'trireg' declarations are not supported yet: a net that stores charge has no word-level form.", d.span);
    let width = 1;
    let msb = 0;
    let lsb = 0;
    let bad = false;
    const type: Var['type'] = net === 'reg' ? 'reg' : net === 'integer' ? 'integer' : 'wire';
    let signed = d.signed;
    if (net === 'integer') {
      width = 32;
      msb = 31;
      signed = true;
    } else if (net === 'time') {
      this.fail('width-limit', "A 'time' variable is 64 bits wide; at most 32 bits are supported.", d.span);
    } else if (d.range) {
      try {
        ({ msb, lsb, width } = this.rangeInfo(d.range, `'${d.declarators[0]!.name.name}'`));
      } catch (e) {
        if (e !== ABORT) throw e;
        bad = true;
        width = 1;
        msb = 0;
        lsb = 0;
      }
    }
    for (const decl of d.declarators) {
      if (this.consumed.has(decl)) continue;
      this.guarded(() => this.declareOne(d, decl, scope, { type, width, msb, lsb, signed, bad }));
    }
  }

  private declareOne(d: A.NetDecl, decl: A.Declarator, scope: Scope, o: { type: Var['type']; width: number; msb: number; lsb: number; signed: boolean; bad: boolean }) {
    const isVar = d.net === 'reg' || d.net === 'integer';
    let mem: Mem | undefined;
    if (decl.dims.length > 1) this.fail('not-supported', 'Arrays with more than one dimension are not supported yet.', decl.dims[1]!.span);
    if (decl.dims.length === 1) {
      const r = decl.dims[0]!;
      const first = this.consts.evalInt(r.msb, this.scope, 'An array bound');
      const last = this.consts.evalInt(r.lsb, this.scope, 'An array bound');
      const depth = Math.abs(first - last) + 1;
      if (depth > 1 << 20) this.fail('width-limit', `The memory '${decl.name.name}' has ${depth} words; at most ${1 << 20} are supported.`, r.span);
      if (!isVar) this.fail('not-supported', `An array of nets ('${decl.name.name}') is not supported yet; only a reg array (a memory) is.`, r.span);
      mem = { width: o.width, depth, first, last, base: Math.min(first, last), readPorts: [], writePorts: [], cellName: scope.prefix + decl.name.name };
    }
    const kind: NetKindIR = NET_KIND[d.net] ?? 'wire';
    const v = this.declareVar(scope, decl.name, {
      type: o.type, netKind: isVar ? 'wire' : kind, width: o.width, signed: o.signed, msb: o.msb, lsb: o.lsb, scalar: d.range === undefined && d.net !== 'integer', isVariable: isVar, mem, bad: o.bad,
    });
    if (!v) return;
    if (decl.init) {
      v.declInit = true;
      if (isVar) this.warn('ignored', `The initial value of '${v.name}' is ignored: a register has no power-on value in the circuit, so it starts unknown (x) until its first clock edge. (The design format cannot hold a register's initial value yet.)`, decl.init.span);
      else this.guarded(() => this.assignWire(decl.name as A.Ident, decl.init!, d.span));
    }
  }

  private assignWire(name: A.Ident, rhs: A.Expr, span: Span) {
    const v = this.resolveVar(name);
    const t = this.consts.lvalueWidth(name, this.scope);
    const word = this.low.assigned(rhs, t);
    this.lintTruncation(t, rhs, span, name.name);
    this.drive(v, 0, t, word.c[0]!, 'an assign expression', span);
  }

  // ------------------------------------------------------------ parameters

  private castParam(d: A.ParamDecl, v: CVal, span: Span): CVal {
    if (d.type === 'real' || d.type === 'realtime') this.fail('not-supported', 'Real parameters are not supported yet.', span);
    if (d.type === 'integer') return cv.resize(v, 32, true);
    if (d.type === 'time') return cv.resize(v, 64, false);
    if (d.range) {
      const msb = this.consts.evalInt(d.range.msb, this.scope, 'A range bound');
      const lsb = this.consts.evalInt(d.range.lsb, this.scope, 'A range bound');
      return cv.resize(cv.withSign(v, d.signed), Math.abs(msb - lsb) + 1, d.signed);
    }
    return d.signed ? cv.withSign(v, true) : v;
  }

  /** Bind `parameter`/`localparam` values (with the overrides given), and register functions, tasks and genvars. */
  resolveParams() {
    const scope = this.root;
    this.scope = scope;
    this.collectLate();
    this.inParams = true;
    this.predeclare(this.decl.items, scope);
    const headerLocal = this.decl.paramPorts !== undefined;
    const names = new Set(this.overrides.keys());
    const decls = [...(this.decl.paramPorts ?? []), ...this.decl.items.filter((i): i is A.ParamDecl => i.kind === 'paramDecl')];
    const diffs: string[] = [];
    const keyParts: string[] = [];
    for (const d of decls) {
      this.doneParams.add(d);
      const local = d.local || (headerLocal && !this.decl.paramPorts!.includes(d));
      for (const a of d.assigns) {
        this.guarded(() => {
          if (scope.syms.has(a.name.name)) this.fail('redeclared', `'${a.name.name}' is already declared.`, a.name.span);
          const dflt = this.castParam(d, this.consts.evalConstOrFail(a.value, scope, `The value of parameter '${a.name.name}'`), a.span);
          let value = dflt;
          const ov = !local ? this.overrides.get(a.name.name) : undefined;
          if (ov) {
            names.delete(a.name.name);
            value = this.castParam(d, ov.value, ov.span);
          } else if (local && this.overrides.has(a.name.name)) {
            this.error('bad-parameter', `'${a.name.name}' is a localparam, so it cannot be overridden.`, this.overrides.get(a.name.name)!.span);
            names.delete(a.name.name);
          }
          scope.syms.set(a.name.name, { kind: 'param', name: a.name.name, value, span: a.name.span, local });
          if (!local) {
            keyParts.push(`${a.name.name}=${cv.toBits(value)}${value.signed ? 's' : ''}`);
            if (cv.toBits(value) !== cv.toBits(dflt) || value.signed !== dflt.signed) diffs.push(`${a.name.name}${formatParam(value)}`);
          }
        });
      }
    }
    for (const n of names) this.error('bad-parameter', `Module '${this.decl.name.name}' has no parameter named '${n}'.`, this.overrides.get(n)!.span);
    this.inParams = false;
    this.key = keyParts.join(',');
    this.irName = diffs.length ? `${this.decl.name.name}_${diffs.join('_')}` : this.decl.name.name;
  }

  private collectLate() {
    for (const p of this.decl.ports) this.signalNames.add(p.name.name);
    for (const item of this.decl.items) {
      if (item.kind === 'portDecl') for (const n of item.names) this.signalNames.add(n.name.name);
      if (item.kind === 'netDecl') for (const d of item.declarators) this.signalNames.add(d.name.name);
    }
    for (const item of this.decl.items) {
      if (item.kind !== 'netDecl') continue;
      for (const d of item.declarators) if (!this.lateDecls.has(d.name.name)) this.lateDecls.set(d.name.name, d.name.span);
    }
  }

  /** Functions, tasks and genvars are visible before their declaration. */
  private predeclare(items: A.ModuleItem[], scope: Scope) {
    for (const item of items) {
      this.guarded(() => {
        if (item.kind === 'function' || item.kind === 'task') {
          if (scope.syms.has(item.name.name)) this.fail('redeclared', `'${item.name.name}' is already declared.`, item.name.span);
          scope.syms.set(item.name.name, item.kind === 'function' ? { kind: 'func', decl: item, scope } : { kind: 'task', decl: item, scope });
        } else if (item.kind === 'genvarDecl') {
          for (const n of item.names) scope.syms.set(n.name, { kind: 'genvar', name: n.name });
        } else if (item.kind === 'defparam') {
          for (const a of item.assigns) this.collectDefparam(a, scope);
        }
      });
    }
  }

  private collectDefparam(a: { target: A.Ref; value: A.Expr; span: Span }, scope: Scope) {
    if (a.target.kind !== 'hier' || a.target.segments.length !== 2 || a.target.segments[0]!.index) {
      this.fail('not-supported', 'A defparam below a direct child instance, such as "defparam m.u.D = 2;", is not supported yet; use "defparam u.D = 2;" or a #(...) override.', a.span);
    }
    const [inst, param] = a.target.segments;
    const key = scope.prefix + inst!.name.name;
    const m = this.defparams.get(key) ?? new Map();
    m.set(param!.name.name, { expr: a.value, scope, span: a.span });
    this.defparams.set(key, m);
  }

  // ------------------------------------------------------------ ports

  private portType(net: A.NetKind | undefined): { type: Var['type']; isVariable: boolean; netKind: NetKindIR } {
    if (net === 'reg') return { type: 'reg', isVariable: true, netKind: 'wire' };
    if (net === 'integer') return { type: 'integer', isVariable: true, netKind: 'wire' };
    return { type: 'wire', isVariable: false, netKind: net ? (NET_KIND[net] ?? 'wire') : 'wire' };
  }

  private declarePort(name: A.Ident, ext: string, dir: 'input' | 'output' | 'inout', net: A.NetKind | undefined, signed: boolean, range: A.RangeSpec | undefined, init: A.Expr | undefined, span: Span) {
    this.guarded(() => {
      let width = 1;
      let msb = 0;
      let lsb = 0;
      let bad = false;
      const isInt = net === 'integer';
      if (isInt) {
        width = 32;
        msb = 31;
        signed = true;
      } else if (range) {
        try {
          ({ msb, lsb, width } = this.rangeInfo(range, `port '${name.name}'`));
        } catch (e) {
          if (e !== ABORT) throw e;
          bad = true;
        }
      }
      if (dir === 'input' && (net === 'reg' || isInt)) this.fail('bad-declaration', `The input port '${name.name}' cannot be a reg. Inputs are always wires.`, span);
      const pt = this.portType(net);
      const v = this.declareVar(this.root, name, { type: pt.type, netKind: pt.netKind, width, signed, msb, lsb, scalar: range === undefined && !isInt, isVariable: pt.isVariable, port: dir, bad });
      if (!v) return;
      if (dir === 'input') this.nl.markDriven(v.net, `the input '${v.name}'`, true);
      if (dir === 'inout') {
        this.error('not-supported', `'inout' ports are not supported yet.`, span);
        bad = true;
      }
      if (init) {
        v.declInit = true;
        if (pt.isVariable) this.warn('ignored', `The initial value of '${v.name}' is ignored: a register has no power-on value in the circuit, so it starts unknown (x) until its first clock edge. (The design format cannot hold a register's initial value yet.)`, init.span);
        else this.guarded(() => this.assignWire(name, init, span));
      }
      this.ports.push({ name: ext, dir, v, bad });
    });
  }

  declarePorts() {
    this.scope = this.root;
    if (this.decl.portStyle === 'ansi') {
      for (const p of this.decl.ports) this.declarePort(p.name, p.name.name, p.dir, p.net, p.signed, p.range, p.init, p.span);
      return;
    }
    if (this.decl.portStyle === 'nonansi') this.declareNonAnsi();
  }

  private declareNonAnsi() {
    const info = new Map<string, { item: A.PortDeclItem; init?: A.Expr; name: A.Ident }>();
    for (const item of this.decl.items) {
      if (item.kind !== 'portDecl') continue;
      this.donePorts.add(item);
      for (const n of item.names) {
        if (info.has(n.name.name)) this.error('redeclared', `'${n.name.name}' is already declared as a port.`, n.name.span);
        else info.set(n.name.name, { item, init: n.init, name: n.name });
      }
    }
    const header = new Set<string>();
    for (const np of this.decl.portList) {
      this.guarded(() => {
        if (np.refs.length === 0) return;
        const ref = np.refs[0]!;
        if (np.braced || np.refs.length > 1 || ref.select) {
          this.fail('not-supported', 'A port that is a part of a vector or a concatenation, such as ".p(a[3:0])" or "{a, b}", is not supported yet. List the whole signal.', np.span);
        }
        const nm = ref.name.name;
        header.add(nm);
        const i = info.get(nm);
        if (!i) this.fail('bad-declaration', `The port '${nm}' is listed in the header but is never declared as input, output or inout.`, ref.name.span);
        let net = i.item.net;
        let signed = i.item.signed;
        let range = i.item.range;
        for (const item of this.decl.items) {
          if (item.kind !== 'netDecl') continue;
          for (const dd of item.declarators) {
            if (dd.name.name !== nm || this.consumed.has(dd)) continue;
            this.consumed.add(dd);
            net = item.net === 'reg' || item.net === 'integer' ? item.net : (net ?? item.net);
            signed ||= item.signed;
            range ??= item.range;
          }
        }
        this.declarePort(ref.name, np.external?.name ?? nm, i.item.dir, net, signed, range, i.init, i.item.span);
      });
    }
    for (const [nm, i] of info) if (!header.has(nm)) this.error('bad-declaration', `'${nm}' is declared as a port but is not in the module's port list.`, i.name.span);
  }

  // ------------------------------------------------------------ driving

  /** The bits of signals an lvalue names, most significant part first. Indexes must be constants. */
  lvalueParts(e: A.Expr, forWire: boolean): { v: Var; lo: number; width: number }[] {
    const scope = this.scope;
    const consts = this.consts;
    if (e.kind === 'concat') return e.parts.flatMap((p) => this.lvalueParts(p, forWire));
    const base = e.kind === 'index' ? e.base : e;
    if (base.kind !== 'ident' && base.kind !== 'hier') return this.fail('bad-assignment', 'This cannot be assigned to.', e.span);
    let v: Var;
    const entry = consts.resolve(base, scope);
    if (!entry && base.kind === 'ident' && forWire) v = this.implicitNet(base);
    else v = this.resolveVar(base);
    if (v.mem) this.fail('bad-assignment', `'${v.name}' is a memory, so it cannot be driven by 'assign'.`, e.span);
    if (e.kind !== 'index') return [{ v, lo: 0, width: v.width }];
    if (v.scalar) this.fail('bad-select', `'${v.name}' is a scalar, declared without a range, so it has no bits to select. Declare it as '[0:0]' to select its bit.`, e.span);
    const asc = v.msb < v.lsb;
    const wsel = consts.selectWidth(e, scope);
    if (e.mode === 'range') {
      const hi = consts.evalInt(e.hi, scope, 'A part-select bound');
      const lo = consts.evalInt(e.lo!, scope, 'A part-select bound');
      if (asc ? hi > lo : hi < lo) this.fail('bad-select', `The part-select [${hi}:${lo}] of '${v.name}' must list the bits in the order the signal is declared, like [${asc ? lo : hi}:${asc ? hi : lo}].`, e.span);
      const pHi = bitPos(v, hi);
      const pLo = bitPos(v, lo);
      if (pHi === undefined || pLo === undefined) this.fail('bad-select', `Bit ${pHi === undefined ? hi : lo} is outside '${v.name}', which has bits ${v.msb} down to ${v.lsb}.`, e.span);
      return [{ v, lo: Math.min(pHi, pLo), width: wsel }];
    }
    const b = consts.evalInt(e.hi, scope, 'A select index');
    const low = e.mode === 'bit' ? b : e.mode === 'plus' ? (asc ? b + wsel - 1 : b) : asc ? b : b - wsel + 1;
    const p = asc ? v.lsb - low : low - v.lsb;
    if (p < 0 || p + wsel > v.width) this.fail('bad-select', `${e.mode === 'bit' ? `Bit ${b}` : `The part-select starting at ${b}`} is outside '${v.name}', which has bits ${v.msb} down to ${v.lsb}.`, e.span);
    return [{ v, lo: p, width: wsel }];
  }

  private implicitNet(id: A.Ident): Var {
    if (this.opts.nettype === 'none') this.fail('undeclared', `'${id.name}' is not declared, and \`default_nettype none forbids creating it implicitly. Declare it as a wire.`, id.span);
    const v = this.declareVar(this.root, id, { type: 'wire', width: 1, signed: false, msb: 0, lsb: 0, scalar: true, isVariable: false, netKind: NET_KIND[this.opts.nettype] ?? 'wire' });
    if (!v) throw ABORT;
    return v;
  }

  /** Record that `net` drives bits [lo, lo+width) of `v`. */
  drive(v: Var, lo: number, width: number, net: NetId, what: string, span: Span, kindOfDriver: 'assign' | 'instance' = 'assign') {
    this.checkDrivable(v, span, kindOfDriver);
    this.pushFrag(v, { lo, width, net, proc: false, what, span });
  }

  /** `a` drives bits of `v` while `en` is 1 and leaves them floating otherwise. */
  driveTri(v: Var, lo: number, width: number, a: NetId, en: NetId, what: string, span: Span) {
    this.checkDrivable(v, span, 'assign');
    this.pushFrag(v, { lo, width, arms: [{ a, en }], proc: false, what, span });
  }

  private checkDrivable(v: Var, span: Span, kindOfDriver: 'assign' | 'instance') {
    if (v.port === 'input') {
      if (kindOfDriver === 'instance') this.fail('bad-connection', `'${v.name}' is an input of this module, so an instance output cannot drive it.`, span);
      this.fail('bad-assignment', `'${v.name}' is an input, so the module cannot drive it.`, span);
    }
    if (v.isVariable) {
      if (kindOfDriver === 'instance') this.fail('bad-connection', `'${v.name}' is a reg, so an instance output cannot drive it. Declare it as a wire.`, span);
      this.fail('bad-assignment', `'${v.name}' is a reg, so 'assign' cannot drive it. Assign it inside an always block, or declare it as a wire.`, span);
    }
  }

  private pushFrag(v: Var, f: Frag) {
    const list = this.frags.get(v);
    if (list) list.push(f);
    else this.frags.set(v, [f]);
  }

  private continuousAssign(a: A.ContinuousAssign) {
    if (a.delay) this.warn('ignored', 'A delay on an assign has no effect in hardware, so it is ignored.', a.delay.span);
    const parts = this.lvalueParts(a.lhs, true);
    const lw = parts.reduce((n, p) => n + p.width, 0);
    const tri = a.lhs.kind !== 'concat' ? this.low.triArms(a.rhs) : undefined;
    if (tri) {
      if (parts.length !== 1) this.fail('not-supported', 'A tri-state value assigned to a concatenation is not supported yet.', a.span);
      const p = parts[0]!;
      for (const arm of tri) {
        const val = this.low.assigned(arm.value, lw).c[0]!;
        const en = arm.en ?? this.nl.constant('1');
        this.driveTri(p.v, p.lo, p.width, val, en, 'a tri-state driver', a.span);
      }
      return;
    }
    const word = this.low.assigned(a.rhs, lw);
    this.lintTruncation(lw, a.rhs, a.span, lvalueName(a.lhs));
    let hi = lw;
    for (const p of parts) {
      hi -= p.width;
      this.drive(p.v, p.lo, p.width, this.nl.wslice(word, hi, p.width).c[0]!, 'an assign expression', a.span);
    }
  }

  // ------------------------------------------------------------ module items

  private elabItems(items: A.ModuleItem[], scope: Scope) {
    const saved = this.scope;
    this.scope = scope;
    try {
      for (const item of items) {
        this.nl.span = item.span;
        this.guarded(() => this.item(item, scope));
      }
    } finally {
      this.scope = saved;
    }
  }

  private item(item: A.ModuleItem, scope: Scope) {
    switch (item.kind) {
      case 'netDecl':
        return this.declareNets(item, scope);
      case 'continuousAssign':
        return this.continuousAssign(item);
      case 'always':
        return this.proc.always(item);
      case 'initial':
        return this.initialBlock(item);
      case 'instance':
        return this.instance(item, scope);
      case 'gate':
        return this.gate(item);
      case 'generateRegion':
        this.predeclare(item.items, scope);
        return this.elabItems(item.items, scope);
      case 'generateFor':
        return this.generateFor(item, scope);
      case 'generateIf':
        return this.generateIf(item, scope);
      case 'generateCase':
        return this.generateCase(item, scope);
      case 'paramDecl':
        if (this.doneParams.has(item)) return;
        return this.localParams(item, scope);
      case 'portDecl':
        if (this.donePorts.has(item)) return;
        return this.fail('bad-declaration', 'A port declaration (input/output/inout) is only allowed directly in a module that lists its ports by name.', item.span);
      case 'specify':
        return this.warn('ignored', 'A specify block describes timing only, so it is ignored.', item.span);
      case 'specparamDecl':
      case 'genvarDecl':
      case 'defparam':
      case 'function':
      case 'task':
        return;
    }
  }

  private localParams(d: A.ParamDecl, scope: Scope) {
    for (const a of d.assigns) {
      const v = this.castParam(d, this.consts.evalConstOrFail(a.value, scope, `The value of parameter '${a.name.name}'`), a.span);
      scope.syms.set(a.name.name, { kind: 'param', name: a.name.name, value: v, span: a.name.span, local: true });
    }
  }

  // ------------------------------------------------------------ initial blocks

  private initialBlock(item: A.InitialBlock) {
    const store = newStore(true);
    try {
      this.consts.exec(item.body, this.scope, store);
    } catch (e) {
      if (e instanceof NotConstant) {
        this.fail('not-synthesizable', `An 'initial' block can only set registers and memories to constants, but it uses '${e.name}', which is not a constant. Anything else is not synthesizable; a testbench feature (coming with the simulator).`, e.span);
      }
      throw e;
    }
    for (const [v, val] of store.vars) {
      if (v.isLocal || v.scratch) continue;
      if (!v.isVariable) this.fail('bad-assignment', `'${v.name}' is a wire, so an initial block cannot set it.`, item.span);
      this.warn('ignored', `The initial value ${cv.toBits(val)} of '${v.name}' is ignored: a register has no power-on value in the circuit, so it starts unknown (x) until its first clock edge. (The design format cannot hold a register's initial value yet.)`, item.span);
    }
    for (const [v, words] of store.mems) {
      const mem = v.mem!;
      const init = mem.init ?? Array.from({ length: mem.depth }, () => 'x'.repeat(mem.width));
      words.forEach((w, i) => {
        const bits = cv.toBits(cv.resize(w, mem.width, false));
        if (!/^x+$/.test(bits)) init[i] = bits;
      });
      mem.init = init;
    }
  }

  // ------------------------------------------------------------ generate

  private blockScope(parent: Scope, name: string): Scope {
    const prefix = `${parent.prefix}${name}.`;
    const s = new Scope('gen', prefix, parent);
    return s;
  }

  private implicitName(scope: Scope, b: A.GenerateBlock): string {
    return b.name?.name ?? `genblk${++scope.genBlocks}`;
  }

  private runGenBlock(b: A.GenerateBlock, scope: Scope, key: string, name: string, genvar?: Genvar) {
    if (++this.genDepth > MAX_DEPTH_GEN) {
      this.genDepth = 0;
      this.fail('too-deep', `Generate blocks are nested more than ${MAX_DEPTH_GEN} levels deep.`, b.span);
    }
    try {
      const child = this.blockScope(scope, key);
      scope.children.set(key, child);
      if (!scope.syms.has(name) && !genvar) scope.syms.set(name, { kind: 'scope', scope: child });
      if (genvar) child.syms.set(genvar.name, genvar);
      this.predeclare(b.items, child);
      this.elabItems(b.items, child);
    } finally {
      this.genDepth--;
    }
  }

  private generateFor(g: A.GenerateFor, scope: Scope) {
    const gname = g.init.genvar.name;
    const entry = scope.lookup(gname);
    if (entry?.kind !== 'genvar') this.fail('bad-generate', `'${gname}' is not a genvar. Declare it with 'genvar ${gname};'.`, g.init.genvar.span);
    if (g.step.genvar.name !== gname) this.fail('bad-generate', 'The step of a generate loop must assign the same genvar as its start.', g.step.genvar.span);
    const name = this.implicitName(scope, g.body);
    const probe = (value: CVal) => {
      const s = new Scope('gen', scope.prefix, scope);
      s.syms.set(gname, { kind: 'genvar', name: gname, value });
      return s;
    };
    let cur = cv.resize(this.consts.evalSelf(g.init.value, probe(cv.fromInt(0))), 32, true);
    let n = 0;
    while (true) {
      const ps = probe(cur);
      const c = cv.truth(this.consts.evalConstOrFail(g.cond, ps, 'The condition of a generate loop'));
      if (!cv.known(c)) this.fail('bad-generate', 'The condition of this generate loop is unknown (x).', g.cond.span);
      if (cv.bigA(c) !== 1n) break;
      if (++n > MAX_GEN) this.fail('bad-generate', `This generate loop runs more than ${MAX_GEN} times, which is more than the compiler will build.`, g.span);
      const idx = cv.toBigInt(cur);
      this.guarded(() => this.runGenBlock(g.body, scope, `${name}[${idx}]`, name, { kind: 'genvar', name: gname, value: cur }));
      cur = cv.resize(this.consts.evalSelf(g.step.value, probe(cur)), 32, true);
    }
  }

  private generateIf(g: A.GenerateIf, scope: Scope) {
    const c = cv.truth(this.consts.evalConstOrFail(g.cond, scope, 'The condition of a generate if'));
    const taken = cv.known(c) && cv.bigA(c) === 1n ? g.then : g.else;
    if (!taken) return;
    const name = this.implicitName(scope, taken);
    this.runGenBlock(taken, scope, name, name);
  }

  private generateCase(g: A.GenerateCase, scope: Scope) {
    const types = [g.expr, ...g.items.flatMap((i) => i.labels ?? [])].map((x) => this.consts.typeOf(x, scope));
    const w = Math.max(...types.map((t) => t.w));
    const s = types.every((t) => t.s);
    const v = this.consts.evalCtx(g.expr, scope, w, s);
    let chosen: A.GenerateCaseItem | undefined;
    let dflt: A.GenerateCaseItem | undefined;
    for (const it of g.items) {
      if (!it.labels) {
        dflt = it;
        continue;
      }
      if (!chosen && it.labels.some((l) => {
        const lv = this.consts.evalCtx(l, scope, w, s);
        return cv.bigA(lv) === cv.bigA(v) && cv.bigB(lv) === cv.bigB(v);
      })) chosen = it;
    }
    const pick = chosen ?? dflt;
    if (!pick) return;
    const name = this.implicitName(scope, pick.body);
    this.runGenBlock(pick.body, scope, name, name);
  }

  // ------------------------------------------------------------ instances

  private instance(inst: A.Instance, scope: Scope) {
    const mname = inst.module.name;
    const decl = this.hier.decl(mname);
    if (!decl) {
      if (this.hier.isPrimitive(mname)) throw ABORT;
      this.fail('unknown-module', `There is no module named '${mname}' in this file.`, inst.module.span);
    }
    if (!inst.name) this.fail('bad-declaration', `An instance of the module '${mname}' needs a name, like '${mname} u1 (...);'.`, inst.span);
    if (inst.drive) this.warn('ignored', 'A drive strength on a module instance has no effect here, so it is ignored.', inst.span);
    const iname = inst.name.name;
    const clash = scope.syms.get(iname);
    if (clash) this.fail('redeclared', `'${iname}' is already used${'span' in clash ? ` on line ${clash.span.line}` : ''}.`, inst.name.span);
    scope.syms.set(iname, { kind: 'inst', span: inst.name.span });
    const count = inst.range ? this.arrayInfo(inst.range) : undefined;
    const n = count?.count ?? 1;

    const overrides = new Map<string, Override>();
    if (inst.params) {
      if (inst.params.style === 'named') {
        for (const it of inst.params.items) {
          if (!it.value) continue;
          this.guarded(() => overrides.set(it.name.name, { value: this.consts.evalConstOrFail(it.value!, scope, `The value of parameter '${it.name.name}'`), span: it.name.span }));
        }
      } else {
        const order = this.hier.paramNames(decl);
        if (inst.params.items.length > order.length) this.error('bad-parameter', `Module '${mname}' has ${order.length} parameter${order.length === 1 ? '' : 's'}, but ${inst.params.items.length} values are given.`, inst.params.items[order.length]!.span);
        inst.params.items.forEach((e, i) => {
          const pn = order[i];
          if (pn === undefined) return;
          this.guarded(() => overrides.set(pn, { value: this.consts.evalConstOrFail(e, scope, `The value of parameter '${pn}'`), span: e.span }));
        });
      }
    }
    const dp = this.defparams.get(scope.prefix + iname);
    if (dp) {
      for (const [pn, d] of dp) this.guarded(() => overrides.set(pn, { value: this.consts.evalConstOrFail(d.expr, d.scope, `The value of parameter '${pn}'`), span: d.span }));
    }
    const callee = this.hier.instantiate(mname, overrides, inst.module.span);
    if (!callee) throw ABORT;
    this.callees.push(callee.irName);

    const conns = new Map<string, A.Expr | undefined>();
    const given = new Set<string>();
    const sigs = callee.ports;
    if (inst.ordered) {
      if (inst.ordered.length > sigs.length && !callee.broken) this.error('bad-connection', `Module '${mname}' has ${sigs.length} port${sigs.length === 1 ? '' : 's'}, but this instance connects ${inst.ordered.length}.`, inst.ordered[sigs.length]!.span);
      inst.ordered.forEach((c, i) => {
        if (sigs[i]) conns.set(sigs[i]!.name, c.expr);
      });
    } else {
      for (const c of inst.conns) {
        const port = sigs.find((p) => p.name === c.port.name);
        if (!port && callee.broken) {
          if (c.expr) this.guarded(() => this.consts.typeOf(c.expr!, scope));
          continue;
        }
        if (!port) {
          this.error('bad-connection', `Module '${mname}' has no port named '${c.port.name}'.`, c.port.span);
          continue;
        }
        if (given.has(port.name)) {
          this.error('bad-connection', `Port '${port.name}' is connected twice.`, c.port.span);
          continue;
        }
        given.add(port.name);
        conns.set(port.name, c.expr);
      }
    }

    const instInputs: Record<string, NetId>[] = Array.from({ length: n }, () => ({}));
    const instOutputs: Record<string, NetId>[] = Array.from({ length: n }, () => ({}));
    const pending: (() => void)[] = [];
    for (const port of sigs) {
      const expr = conns.get(port.name);
      if (!expr) continue;
      if (port.bad) {
        this.guarded(() => this.low.lowerSelf(expr));
        continue;
      }
      this.guarded(() => {
        const pw = port.width;
        if (port.dir === 'in') {
          const t = this.consts.typeOf(expr, scope);
          const w = this.low.lowerSelf(expr);
          if (count && w.w !== pw && w.w !== pw * n) this.fail('bad-connection', `The port '${port.name}' is ${pw} bits wide and this instance array has ${n} instances, so it needs a ${pw}-bit or ${pw * n}-bit connection, but this one is ${w.w} bits.`, expr.span);
          for (let k = 0; k < n; k++) {
            const piece = count && w.w === pw * n ? this.nl.wslice(w, (n - 1 - k) * pw, pw) : w;
            instInputs[k]![port.name] = this.nl.wresize(piece, pw, t.s).c[0]!;
          }
          return;
        }
        const parts = this.lvalueParts(expr, true);
        const lw = parts.reduce((s, p) => s + p.width, 0);
        if (count && lw !== pw * n && lw !== pw) this.fail('bad-connection', `The port '${port.name}' is ${pw} bits wide and this instance array has ${n} instances, so it needs a ${pw * n}-bit target, but this one is ${lw} bits.`, expr.span);
        for (let k = 0; k < n; k++) {
          const out = this.nl.newNet(pw);
          instOutputs[k]![port.name] = out;
          const base = count && lw === pw * n ? (n - 1 - k) * pw : 0;
          pending.push(() => {
            let top = lw;
            for (const p of parts) {
              top -= p.width;
              const from = Math.max(top, base);
              const to = Math.min(top + p.width, base + pw);
              if (from >= to) continue;
              this.drive(p.v, p.lo + (from - top), to - from, this.nl.slice(out, from - base, to - from), `the output '${port.name}' of instance '${iname}'`, expr.span, 'instance');
            }
          });
        }
      });
    }
    const order = (m: Record<string, NetId>) => Object.fromEntries(sigs.filter((p) => p.name in m).map((p) => [p.name, m[p.name]!]));
    for (let k = 0; k < n; k++) {
      const flatName = scope.prefix + iname + (count ? `[${count.index(k)}]` : '');
      this.nl.span = inst.span;
      const cell: Cell = { kind: 'instance', module: callee.irName, name: flatName, inputs: order(instInputs[k]!), outputs: order(instOutputs[k]!) };
      this.nl.emit(cell, Object.values(cell.outputs));
    }
    this.guarded(() => pending.forEach((f) => f()));
  }

  private arrayInfo(r: A.RangeSpec): { count: number; index: (k: number) => number } {
    const msb = this.consts.evalInt(r.msb, this.scope, 'An instance array bound');
    const lsb = this.consts.evalInt(r.lsb, this.scope, 'An instance array bound');
    const count = Math.abs(msb - lsb) + 1;
    return { count, index: (k) => (msb >= lsb ? msb - k : msb + k) };
  }

  // ------------------------------------------------------------ gates

  private gate(g: A.GateInst) {
    const kind = g.gate;
    const count = g.range ? this.arrayInfo(g.range) : undefined;
    const n = count?.count ?? 1;
    if (g.delay) this.warn('ignored', 'A delay on a gate has no effect in hardware, so it is ignored.', g.delay.span);
    const nl = this.nl;
    const t = g.terminals;
    if (kind === 'pullup' || kind === 'pulldown') {
      for (const term of t) {
        for (const p of this.lvalueParts(term, true)) p.v.pulls.push({ lo: p.lo, width: p.width, kind: kind === 'pullup' ? 'pull1' : 'pull0' });
      }
      return;
    }
    const arity = (min: number) => {
      if (t.length < min) this.fail('bad-connection', `A '${kind}' gate needs at least ${min} connections, but this one has ${t.length}.`, g.span);
    };
    const bitFor = (expr: A.Expr, k: number): NetId => {
      const w = this.low.lowerSelf(expr);
      if (w.w === 1) return w.c[0]!;
      if (count && w.w === n) return nl.wslice(w, n - 1 - k, 1).c[0]!;
      return this.fail('bad-connection', `A gate connection is one bit wide, but this one is ${w.w} bits${count ? ` (an array of ${n} gates needs 1 or ${n})` : ''}.`, expr.span);
    };
    const driveBit = (expr: A.Expr, k: number, net: NetId, en?: NetId) => {
      const parts = this.lvalueParts(expr, true);
      const lw = parts.reduce((s, p) => s + p.width, 0);
      let pos: number;
      if (lw === 1) pos = 0;
      else if (count && lw === n) pos = n - 1 - k;
      else return this.fail('bad-connection', `A gate connection is one bit wide, but this one is ${lw} bits${count ? ` (an array of ${n} gates needs 1 or ${n})` : ''}.`, expr.span);
      let hi = lw;
      for (const p of parts) {
        hi -= p.width;
        if (pos >= hi && pos < hi + p.width) {
          if (en !== undefined) this.driveTri(p.v, p.lo + (pos - hi), 1, net, en, 'a tri-state gate', g.span);
          else this.drive(p.v, p.lo + (pos - hi), 1, net, 'a gate', g.span);
        }
      }
    };
    switch (kind) {
      case 'and':
      case 'nand':
      case 'or':
      case 'nor':
      case 'xor':
      case 'xnor': {
        arity(3);
        for (let k = 0; k < n; k++) {
          const ins = t.slice(1).map((e) => bitFor(e, k));
          const base = kind === 'and' || kind === 'nand' ? 'and' : kind === 'or' || kind === 'nor' ? 'or' : 'xor';
          let r = ins[0]!;
          for (const x of ins.slice(1)) r = nl.bitwise(base, r, x);
          if (kind === 'nand' || kind === 'nor' || kind === 'xnor') r = nl.not(r);
          driveBit(t[0]!, k, r);
        }
        return;
      }
      case 'buf':
      case 'not': {
        arity(2);
        const input = t[t.length - 1]!;
        for (let k = 0; k < n; k++) {
          const i = bitFor(input, k);
          const r = kind === 'not' ? nl.not(i) : i;
          for (const o of t.slice(0, -1)) driveBit(o, k, r);
        }
        return;
      }
      case 'bufif0':
      case 'bufif1':
      case 'notif0':
      case 'notif1': {
        arity(3);
        for (let k = 0; k < n; k++) {
          let d = bitFor(t[1]!, k);
          let en = bitFor(t[2]!, k);
          if (kind.startsWith('not')) d = nl.not(d);
          if (kind.endsWith('0')) en = nl.not(en);
          driveBit(t[0]!, k, d, en);
        }
        return;
      }
      default:
        this.fail('not-supported', `The '${kind}' switch primitive is not supported yet; only and/or/xor-style gates, buf/not and bufif/notif are.`, g.span);
    }
  }

  // ------------------------------------------------------------ the module

  elaborateBody() {
    this.scope = this.root;
    const rest = this.decl.items.filter((i) => i.kind !== 'portDecl' || !this.donePorts.has(i));
    this.elabItems(rest, this.root);
  }

  /** The enables and values of a combinational result that is built from `en ? a : 'bz`, or undefined when no arm is z. */
  private triArmsOfNet(d: NetId, cellOf: Map<NetId, Cell>): { a: NetId; en: NetId }[] | undefined {
    const nl = this.nl;
    const arms: { a: NetId; en: NetId }[] = [];
    let sawZ = false;
    const walk = (n: NetId, en: NetId | undefined, depth: number) => {
      const cell = cellOf.get(nl.find(n));
      if (cell?.kind === 'mux' && depth < 64) {
        const t = en === undefined ? cell.sel : nl.bitwise('and', en, cell.sel);
        const f = en === undefined ? nl.not(cell.sel) : nl.bitwise('and', en, nl.not(cell.sel));
        walk(cell.onTrue, t, depth + 1);
        walk(cell.onFalse, f, depth + 1);
        return;
      }
      if (/^z+$/.test(nl.constBits(n) ?? '')) {
        sawZ = true;
        return;
      }
      arms.push({ a: n, en: en ?? nl.constant('1') });
    };
    walk(d, undefined, 0);
    return sawZ ? arms : undefined;
  }

  /** Build the cells for what the always blocks produced, then resolve every signal's drivers. */
  private commit() {
    const nl = this.nl;
    const cellOf = nl.producerCells();
    for (const out of this.outs) {
      const v = out.v;
      const hasNonblocking = v.nonblockingWrites > 0;
      const dead = !v.netRead && v.port === undefined;
      if (v.scratch && dead) continue;
      if (out.clocked && !hasNonblocking && dead) continue;
      nl.span = out.span;
      let q = out.d;
      switch (out.kind) {
        case 'wire': {
          const arms = this.triArmsOfNet(out.d, cellOf);
          if (arms) {
            this.pushFrag(v, { lo: out.lo, width: out.width, arms, proc: true, what: 'an always block', span: out.span });
            continue;
          }
          break;
        }
        case 'dff':
          q = nl.newNet(out.width);
          nl.emit({ kind: 'dff', clk: out.clk!, edge: out.edge!, d: out.d, q }, [q]);
          break;
        case 'adff':
          q = nl.newNet(out.width);
          nl.emit({ kind: 'adff', clk: out.clk!, edge: out.edge!, arst: out.arst!, arstLevel: out.arstLevel!, arstValue: out.arstValue!, d: out.d, q }, [q]);
          break;
        case 'latch':
          q = nl.newNet(out.width);
          nl.emit({ kind: 'latch', en: out.en!, enLevel: 1, d: out.d, q }, [q]);
          break;
      }
      if (out.kind !== 'wire') this.dffVars.push(v);
      this.pushFrag(v, { lo: out.lo, width: out.width, net: q, proc: true, what: 'an always block', span: out.span });
    }
    for (const v of this.vars) {
      const list = this.frags.get(v);
      if (list || v.pulls.length > 0) this.guarded(() => this.composeVar(v, list ?? []));
    }
    for (const v of this.vars) {
      if (!v.mem) continue;
      const mem = v.mem;
      if (mem.readPorts.length === 0 && mem.writePorts.length === 0 && !mem.init) continue;
      this.nl.span = v.span;
      const cell: Cell = { kind: 'memory', name: mem.cellName, width: mem.width, depth: mem.depth, ...(mem.init ? { init: mem.init } : {}), readPorts: mem.readPorts, writePorts: mem.writePorts };
      nl.emit(cell, mem.readPorts.map((p) => p.data));
    }
    this.fuseSyncReads();
  }

  /**
   * `dout <= mem[addr]` is an asynchronous read feeding a register. A memory can do that itself with a
   * synchronous read port, which also returns the old word when the same edge writes it, as the register would.
   */
  private fuseSyncReads() {
    const nl = this.nl;
    const readers = new Map<NetId, number>();
    for (const c of nl.cells) for (const n of cellInputs(c)) readers.set(nl.find(n), (readers.get(nl.find(n)) ?? 0) + 1);
    for (const p of this.ports) readers.set(nl.find(p.v.net), (readers.get(nl.find(p.v.net)) ?? 0) + 1);
    for (const v of this.vars) {
      for (const port of v.mem?.readPorts ?? []) {
        if (port.clk !== undefined) continue;
        const root = nl.find(port.data);
        if (readers.get(root) !== 1) continue;
        const dff = nl.cells.find((c): c is Extract<Cell, { kind: 'dff' }> => c.kind === 'dff' && nl.find(c.d) === root);
        if (!dff) continue;
        port.clk = dff.clk;
        port.edge = dff.edge;
        nl.removeCell(dff);
        nl.union(dff.q, port.data);
      }
    }
  }

  /**
   * Make one net out of the pieces that drive a signal. The bits are cut wherever a driver or a pull starts or
   * stops; each piece is then one driver, several tri-state arms, or nothing (floating). Two ordinary drivers on
   * the same bits are an error, except on a `wand` or `wor` net, where they are combined.
   */
  private composeVar(v: Var, list: Frag[]) {
    const nl = this.nl;
    const cuts = new Set<number>([0, v.width]);
    for (const f of list) {
      cuts.add(f.lo);
      cuts.add(f.lo + f.width);
    }
    for (const p of v.pulls) {
      cuts.add(p.lo);
      cuts.add(p.lo + p.width);
    }
    const pts = [...cuts].sort((a, b) => a - b);
    const pieces: NetId[] = [];
    let reported = false;
    const plainSlice = (f: Frag, lo: number, w: number) => (f.lo === lo && f.width === w ? f.net! : nl.slice(f.net!, lo - f.lo, w));
    for (let i = 0; i + 1 < pts.length; i++) {
      const lo = pts[i]!;
      const w = pts[i + 1]! - lo;
      const cover = list.filter((f) => f.lo <= lo && f.lo + f.width >= lo + w);
      const plain = cover.filter((f) => f.net !== undefined);
      const tri = cover.filter((f) => f.arms !== undefined);
      const pull = v.pulls.find((p) => p.lo <= lo && p.lo + p.width >= lo + w);
      let net: NetId;
      const combine = v.netKind === 'wand' || v.netKind === 'wor';
      if (plain.length > 1 && combine && tri.length === 0) {
        net = plainSlice(plain[0]!, lo, w);
        for (const f of plain.slice(1)) net = nl.bitwise(v.netKind === 'wand' ? 'and' : 'or', net, plainSlice(f, lo, w));
      } else if (plain.length + (tri.length > 0 ? 1 : 0) > 1) {
        if (!reported) {
          reported = true;
          const [a, b] = [...plain, ...tri];
          this.error(
            'multiple-drivers',
            a!.proc && b!.proc
              ? `The reg '${v.name}' is assigned in more than one always block. A reg must be assigned in exactly one always block.`
              : `'${v.name}' has more than one driver: ${a!.what} and ${b!.what}. A signal can have only one driver.`,
            b!.span,
          );
        }
        net = plain.length > 0 ? plainSlice(plain[0]!, lo, w) : nl.freshConst('z'.repeat(w));
      } else if (plain.length === 1) net = plainSlice(plain[0]!, lo, w);
      else if (tri.length > 0) {
        net = nl.newNet(w);
        for (const f of tri) {
          nl.span = f.span;
          for (const arm of f.arms!) nl.tribuf(f.lo === lo && f.width === w ? arm.a : nl.slice(arm.a, lo - f.lo, w), arm.en, net);
        }
      } else net = nl.freshConst('z'.repeat(w));
      if (pull) nl.setKind(net, pull.kind);
      pieces.push(net);
    }
    if (list.length === 0 && v.pulls.length === 0) return;
    nl.union(v.net, pieces.length === 1 ? pieces[0]! : nl.concat([...pieces].reverse()));
  }

  private reportConflicts() {
    for (const c of this.nl.conflicts()) {
      const quoted = c.names.map((n) => `'${n}'`).join(', ');
      const by = c.list.map((p) => p.what).join(' and ');
      const message =
        c.names.length > 1
          ? `${quoted} are connected together, but more than one source drives them: ${by}. A signal can have only one driver.`
          : `'${c.names[0] ?? 'a signal'}' has more than one driver: ${by}. A signal can have only one driver.`;
      this.error('multiple-drivers', message, c.list[1]!.span);
    }
  }

  private warnings() {
    const nl = this.nl;
    const outputs = new Set(this.ports.filter((p) => p.dir === 'output').map((p) => p.v));
    for (const v of this.vars) {
      if (v.port === 'input' || v.mem || nl.isDriven(v.net)) continue;
      if (outputs.has(v) || v.netRead) {
        const what =
          v.isVariable
            ? `The reg '${v.name}' is never assigned. A Verilog simulator starts every reg unknown (x) and this one stays so, but hardware has no such state: the wire would float (z).`
            : `'${v.name}' is never driven, so it reads as unknown. In hardware an undriven wire floats (z), which a gate reads as unknown.`;
        this.warn('undriven', what, v.span);
      }
    }
    this.warnAboutClocks();
    this.warnAboutUnknownConditions();
    for (const v of this.vars) {
      if (v.blockingWrites > 0 && v.nonblockingWrites > 0 && !v.isLocal) {
        this.warn('mixed-assignment', `The reg '${v.name}' is assigned with both blocking (=) and nonblocking (<=) assignments. Mixing them is a common source of simulation/hardware mismatches; use <= in clocked blocks and = in combinational ones.`, v.span);
      }
      if (v.mentioned || v.netRead || v.scratch || v.isLocal || v.name.startsWith('_')) continue;
      if (v.port === 'output') continue;
      if (v.mem && v.mem.readPorts.length > 0) continue;
      const assigned = this.frags.has(v) || v.blockingWrites + v.nonblockingWrites > 0 || v.port === 'input';
      this.warn(
        'unused-signal',
        v.port === 'input' ? `The input '${v.name}' is never used.` : assigned ? `'${v.name}' is assigned but its value is never used.` : `'${v.name}' is declared but never used.`,
        v.span,
      );
    }
  }

  private warnAboutClocks() {
    const nl = this.nl;
    const portRoots = new Set(nl.producers.filter((p) => p.isPort).map((p) => nl.find(p.net)));
    const reported = new Set<string>();
    const cellOf = nl.producerCells();
    const fromPort = (n: NetId, depth = 0): boolean => {
      const root = nl.find(n);
      if (portRoots.has(root)) return true;
      const c = cellOf.get(root);
      return depth < 32 && c?.kind === 'slice' ? fromPort(c.a, depth + 1) : false;
    };
    for (const use of this.clockUses) {
      if (fromPort(use.net) || !nl.isDriven(use.net)) continue;
      const key = `${use.name}:${use.span.start}`;
      if (reported.has(key)) continue;
      reported.add(key);
      this.warn('gated-clock', `The clock '${use.name}' comes out of logic instead of straight from an input, and gated or derived clocks are bad practice in real hardware because the clock edge reaches different registers at different times (clock skew).`, use.span);
    }
  }

  private warnAboutUnknownConditions() {
    if (this.ifConditions.length === 0) return;
    const nl = this.nl;
    const cellOf = nl.producerCells();
    const symOfReg = new Map<NetId, Var>();
    for (const v of this.dffVars) symOfReg.set(nl.find(v.net), v);
    const reset = new Set<Var>();
    for (const o of this.outs) {
      if (o.kind === 'adff') reset.add(o.v);
      else if (o.kind === 'dff' && this.assignsConstant(o.d, cellOf)) reset.add(o.v);
    }
    const reported = new Set<string>();
    for (const cond of this.ifConditions) {
      const seen = new Set<NetId>();
      const stack = [nl.find(cond.net)];
      while (stack.length) {
        const root = stack.pop()!;
        if (seen.has(root)) continue;
        seen.add(root);
        const reg = symOfReg.get(root);
        if (reg) {
          const key = `${cond.span.start}:${reg.name}`;
          if (!reset.has(reg) && !reported.has(key)) {
            reported.add(key);
            this.warn('if-unknown-condition', `\`${reg.name}\` has no reset, so until it is first written it is unknown. A Verilog simulator then takes the else branch, but real hardware (and this circuit) could go either way. Give \`${reg.name}\` a reset value to make both agree.`, cond.span);
          }
          continue;
        }
        const cell = cellOf.get(root);
        if (!cell || cell.kind === 'instance' || cell.kind === 'const') continue;
        for (const n of cellInputsOf(cell)) stack.push(nl.find(n));
      }
    }
  }

  private assignsConstant(d: NetId, cellOf: Map<NetId, Cell>): boolean {
    const nl = this.nl;
    const seen = new Set<NetId>();
    const stack: { root: NetId; viaMux: boolean }[] = [{ root: nl.find(d), viaMux: false }];
    while (stack.length) {
      const { root, viaMux } = stack.pop()!;
      if (seen.has(root)) continue;
      seen.add(root);
      const cell = cellOf.get(root);
      if (cell?.kind === 'const' && viaMux) return true;
      if (cell?.kind === 'mux') stack.push({ root: nl.find(cell.onTrue), viaMux: true }, { root: nl.find(cell.onFalse), viaMux: true });
    }
    return false;
  }

  /** Finish the module: build the pending cells, check drivers, warn, and produce the IR. */
  finish(known: Map<string, CombSummary>): ModuleResult {
    this.nl.span = this.decl.span;
    this.commit();
    this.reportConflicts();
    if (this.errors === 0 && !this.opts.broken) this.warnings();
    const ports = this.ports.filter((p) => p.dir !== 'inout');
    const irPorts = ports.map((p) => ({ name: p.name, dir: (p.dir === 'input' ? 'in' : 'out') as 'in' | 'out', width: p.v.width, net: p.v.net }));
    const module = this.nl.finish(this.irName, irPorts);
    if (this.errors === 0 && !this.opts.broken) {
      for (const names of findCombLoops(module, known)) {
        const shown = names.slice(0, 6).map((n) => `'${n}'`).join(', ');
        this.warn('comb-loop', `A combinational loop: ${shown || 'some signals'} feed themselves through logic with no register in between. The circuit may oscillate or hold a value, depending on the gates; if you meant to store a bit, use a register or latch.`, this.decl.span);
      }
    }
    return {
      irName: this.irName,
      module,
      ports: this.ports.map((p) => ({ name: p.name, dir: p.dir === 'input' ? 'in' : 'out', width: p.v.width, signed: p.v.signed, bad: p.bad || p.dir === 'inout' })),
      callees: this.callees,
      comb: summarize(module, known),
      broken: this.opts.broken,
    };
  }
}

function cellInputsOf(c: Cell): NetId[] {
  switch (c.kind) {
    case 'const':
      return [];
    case 'not':
    case 'slice':
    case 'reduce_and':
    case 'reduce_or':
    case 'reduce_xor':
      return [c.a];
    case 'mux':
      return [c.sel, c.onFalse, c.onTrue];
    case 'concat':
      return [...c.parts];
    case 'shl':
    case 'shr':
    case 'sshr':
      return [c.a, c.amount];
    case 'dff':
      return [c.clk, c.d];
    case 'adff':
      return [c.clk, c.arst, c.d];
    case 'latch':
      return [c.en, c.d];
    case 'tribuf':
      return [c.a, c.en];
    case 'memory':
    case 'instance':
      return [];
    default:
      return [c.a, c.b];
  }
}

function formatParam(v: CVal): string {
  if (!cv.known(v)) return `b${cv.toBits(v)}`;
  const n = cv.toBigInt(v);
  if (v.width >= 16 && v.width % 8 === 0) {
    const bytes = cv.toBits(v).match(/.{8}/g)!.map((b) => parseInt(b, 2));
    if (bytes.every((c) => c >= 32 && c < 127) && bytes.some((c) => /[A-Za-z]/.test(String.fromCharCode(c)))) return String.fromCharCode(...bytes).replace(/[^A-Za-z0-9]/g, '_');
  }
  const dec = n < 0n ? `m${-n}` : n.toString();
  return dec.length <= 12 ? dec : `h${(n < 0n ? n + (1n << BigInt(v.width)) : n).toString(16)}`;
}

