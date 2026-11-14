import type * as A from './ast';
import type { Design } from './design';
import { type DiagnosticSink, type Span } from './diagnostics';
import type { Directive } from './preprocess';
import { type Hier, ModuleElab, type ModuleResult, type Override } from './elab/module';
import type { CombSummary } from './elab/lint';

/**
 * Elaboration: AST to the word-level Design.
 *
 * The work is split by concern under `elab/`:
 *   cval.ts       four-state constants of any width and their operators
 *   consteval.ts  expression types (IEEE 1364-2005 5.4/5.5), constant evaluation, constant functions
 *   scope.ts      the names elaboration knows
 *   netlist.ts    nets, cells with folding and sharing, wide words
 *   expr.ts       expressions to hardware
 *   proc.ts       always blocks by symbolic execution
 *   module.ts     one module: declarations, assignments, instances, gates, generate
 *   lint.ts       lints over the finished circuit
 * This file walks the module hierarchy: each distinct parameter binding of a module becomes its own IR module.
 */

export interface ElaborateOptions {
  top?: string;
  files?: Record<string, string>;
  directives?: Directive[];
}

const FILE_START: Span = { start: 0, end: 0, line: 1, col: 1 };
const MAX_NEST = 64;

class Hierarchy implements Hier {
  readonly decls = new Map<string, A.ModuleDecl>();
  readonly prims = new Set<string>();
  private readonly cache = new Map<string, ModuleResult | 'active'>();
  private readonly chain: string[] = [];
  readonly results: ModuleResult[] = [];
  private readonly claimed = new Map<string, string>();
  private readonly summaries = new Map<string, CombSummary>();
  broken = new Set<A.ModuleDecl>();
  /** Names of the modules that have been elaborated under some parameter binding. */
  readonly seen = new Set<string>();

  constructor(
    private readonly sink: DiagnosticSink,
    private readonly files: Record<string, string>,
    private readonly directives: Directive[],
  ) {}

  decl(name: string) {
    return this.decls.get(name);
  }

  isPrimitive(name: string) {
    return this.prims.has(name);
  }

  paramNames(decl: A.ModuleDecl): string[] {
    const out: string[] = [];
    const list = decl.paramPorts ?? decl.items.filter((i): i is A.ParamDecl => i.kind === 'paramDecl');
    for (const d of list) if (!d.local) for (const a of d.assigns) out.push(a.name.name);
    return out;
  }

  private nettype(decl: A.ModuleDecl): string {
    let t = 'wire';
    for (const d of this.directives) {
      if (d.span.start > decl.span.start) break;
      if (d.name === 'default_nettype') t = d.args.trim();
      else if (d.name === 'resetall') t = 'wire';
    }
    return t;
  }

  instantiate(name: string, overrides: Map<string, Override>, span: Span): ModuleResult | undefined {
    const decl = this.decls.get(name)!;
    const m = new ModuleElab(decl, overrides, this, { files: this.files, nettype: this.nettype(decl), broken: this.broken.has(decl) });
    m.resolveParams();
    const key = `${name}|${m.key}`;
    const hit = this.cache.get(key);
    if (hit === 'active') {
      const at = this.chain.indexOf(name);
      const cycle = this.chain.slice(at).concat(name);
      const via = cycle.length === 2 ? `'${name}' instantiates itself` : `'${cycle.join("' -> '")}' instantiate each other in a loop`;
      this.sink.error('recursive-instantiation', `Recursion is not allowed: ${via}.`, span);
      return undefined;
    }
    if (hit) return hit;
    if (this.chain.length >= MAX_NEST) {
      this.sink.error('too-deep', `Modules are instantiated more than ${MAX_NEST} levels deep, which the compiler does not support.`, span);
      return undefined;
    }
    let irName = m.irName;
    for (let i = 2; this.claimed.has(irName); i++) irName = `${m.irName}_${i}`;
    m.irName = irName;
    this.claimed.set(irName, key);
    this.cache.set(key, 'active');
    this.chain.push(name);
    let result: ModuleResult;
    try {
      m.declarePorts();
      m.elaborateBody();
      result = m.finish(this.summaries);
    } finally {
      this.chain.pop();
    }
    // A module whose text did not parse is only half there, so what elaboration says about names and drivers in it
    // would be noise; the constructs it cannot build are still reported.
    const keep = new Set(['not-supported', 'not-synthesizable']);
    for (const d of m.sink.items) if (!this.broken.has(decl) || keep.has(d.code)) this.sink.items.push(d);
    this.cache.set(key, result);
    this.seen.add(name);
    this.results.push(result);
    this.summaries.set(result.irName, result.comb);
    return result;
  }
}

function instantiatedNames(items: A.ModuleItem[], out: Set<string>) {
  const block = (b: A.GenerateBlock | undefined) => b && instantiatedNames(b.items, out);
  for (const it of items) {
    switch (it.kind) {
      case 'instance':
        out.add(it.module.name);
        break;
      case 'generateRegion':
        instantiatedNames(it.items, out);
        break;
      case 'generateFor':
        block(it.body);
        break;
      case 'generateIf':
        block(it.then);
        block(it.else);
        break;
      case 'generateCase':
        for (const c of it.items) block(c.body);
        break;
      default:
    }
  }
}

/** Elaborate every module, then pick the top and keep what it reaches. Returns undefined when errors were reported. */
export function elaborate(file: A.SourceFile, opts: ElaborateOptions, sink: DiagnosticSink): Design | undefined {
  const syntaxErrors = sink.items.filter((d) => d.severity === 'error');
  const hier = new Hierarchy(sink, opts.files ?? {}, opts.directives ?? []);
  const order: A.ModuleDecl[] = [];
  for (const u of file.units) {
    if (u.kind === 'module') {
      const prev = hier.decls.get(u.name.name);
      if (prev) {
        sink.error('duplicate-module', `The module '${u.name.name}' is already defined on line ${prev.name.span.line}.`, u.name.span);
        continue;
      }
      hier.decls.set(u.name.name, u);
      order.push(u);
      if (syntaxErrors.some((d) => d.span.start >= u.span.start && d.span.start <= u.span.end)) hier.broken.add(u);
    } else if (u.kind === 'udp') {
      sink.error('not-supported', "'primitive' blocks are not supported yet.", u.span);
      hier.prims.add(u.name.name);
    } else sink.error('not-supported', "'config' blocks are not supported yet.", u.span);
  }
  if (order.length === 0) {
    if (!sink.hasErrors) sink.error('no-modules', 'The source contains no module.', FILE_START);
    return undefined;
  }
  const instantiated = new Set<string>();
  for (const d of order) instantiatedNames(d.items, instantiated);
  // A module that other modules instantiate is built with their parameters; one nobody instantiates, or that
  // is only reached through a loop, is built with its defaults so it is still checked.
  for (const d of order) if (!instantiated.has(d.name.name)) hier.instantiate(d.name.name, new Map(), d.name.span);
  for (const d of order) if (!hier.seen.has(d.name.name)) hier.instantiate(d.name.name, new Map(), d.name.span);

  let top: string | undefined;
  if (opts.top !== undefined) {
    if (!hier.decls.has(opts.top)) sink.error('top-not-found', `There is no module named '${opts.top}'. This file defines: ${order.map((d) => d.name.name).join(', ')}.`, FILE_START);
    else top = opts.top;
  } else {
    const roots = order.filter((d) => !instantiated.has(d.name.name));
    if (roots.length === 1) top = roots[0]!.name.name;
    else if (roots.length > 1 && !sink.hasErrors) {
      sink.error('ambiguous-top', `More than one module is never instantiated (${roots.map((r) => r.name.name).join(', ')}), so the top module is ambiguous. Name it with the 'top' option.`, roots[0]!.name.span);
    }
  }
  if (sink.hasErrors || top === undefined) return undefined;
  const topResult = hier.instantiate(top, new Map(), hier.decls.get(top)!.name.span);
  if (!topResult) return undefined;

  const byName = new Map(hier.results.map((r) => [r.irName, r]));
  const done = new Set<string>();
  const ordered: ModuleResult[] = [];
  const visit = (r: ModuleResult) => {
    if (done.has(r.irName)) return;
    done.add(r.irName);
    for (const c of r.callees) visit(byName.get(c)!);
    ordered.push(r);
  };
  visit(topResult);
  return { modules: ordered.map((r) => r.module), top: topResult.irName };
}
