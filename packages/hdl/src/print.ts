import type * as A from './ast';
import { KEYWORDS } from './lexer';

/**
 * Syntax tree back to Verilog text.
 *
 * It is the test oracle for the parser (`parse(print(parse(src)))` has the same tree as `parse(src)`, spans
 * aside) and the base for formatted export. Parentheses are written only where precedence needs them, lists
 * the parser split are written one item at a time, and the layout is two-space indentation with one statement
 * per line.
 */

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
const PRIMARY = 100;
/** A unary expression is not a primary, so it needs parentheses as the operand of another unary operator. */
const UNARY_BP = 50;

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function name(n: A.Ident): string {
  return SIMPLE_NAME.test(n.name) && !KEYWORDS.has(n.name) ? n.name : `\\${n.name} `;
}

function ref(r: A.Ref): string {
  if (r.kind === 'ident') return name(r);
  return r.segments.map((s) => name(s.name) + (s.index ? `[${expr(s.index)}]` : '')).join('.');
}

function attrs(list: A.Attribute[] | undefined): string {
  if (!list || list.length === 0) return '';
  return `(* ${list.map((a) => name(a.name) + (a.value ? ` = ${expr(a.value)}` : '')).join(', ')} *) `;
}

function select(hi: A.Expr, lo: A.Expr | undefined, mode: A.IndexExpr['mode']): string {
  switch (mode) {
    case 'bit':
      return `[${expr(hi)}]`;
    case 'range':
      return `[${expr(hi)}:${expr(lo!)}]`;
    case 'plus':
      return `[${expr(hi)} +: ${expr(lo!)}]`;
    case 'minus':
      return `[${expr(hi)} -: ${expr(lo!)}]`;
  }
}

/** An expression, in parentheses when its binding power is below `min`. */
export function expr(e: A.Expr, min = 0): string {
  if (e.kind !== 'binary') return leaf(e, min);
  // A chain of left-nested binary operators is walked in a loop so a very long one does not use the stack.
  const spine: A.BinaryExpr[] = [];
  let cur: A.Expr = e;
  while (cur.kind === 'binary') {
    spine.push(cur);
    cur = cur.lhs;
  }
  let acc = leaf(cur, BINARY_BP[spine[spine.length - 1]!.op]!);
  for (let i = spine.length - 1; i >= 0; i--) {
    const b = spine[i]!;
    const own = BINARY_BP[b.op]!;
    if (i < spine.length - 1 && BINARY_BP[spine[i + 1]!.op]! < own) acc = `(${acc})`;
    acc = `${acc} ${b.op} ${attrs(b.attrs)}${expr(b.rhs, own + 1)}`;
  }
  return BINARY_BP[e.op]! < min ? `(${acc})` : acc;
}

function leaf(e: A.Expr, min: number): string {
  const wrap = (s: string, own: number) => (own < min ? `(${s})` : s);
  switch (e.kind) {
    case 'ident':
      return name(e);
    case 'hier':
      return ref(e);
    case 'number':
    case 'real':
    case 'string':
      return e.text;
    case 'index':
      return ref(e.base) + e.dims.map((d) => `[${expr(d)}]`).join('') + select(e.hi, e.lo, e.mode);
    case 'concat':
      return `{${e.parts.map((p) => expr(p)).join(', ')}}`;
    case 'replicate':
      return `{${expr(e.count)}{${e.inner.parts.map((p) => expr(p)).join(', ')}}}`;
    case 'unary':
      return wrap(`${e.op}${e.attrs ? ` ${attrs(e.attrs)}` : ''}${expr(e.operand, PRIMARY)}`, UNARY_BP);
    case 'binary':
      return expr(e, min);
    case 'ternary':
      return wrap(`${expr(e.cond, 2)} ? ${attrs(e.attrs)}${expr(e.then)} : ${expr(e.else, 1)}`, 1);
    case 'mintypmax':
      return `(${expr(e.min)} : ${expr(e.typ)} : ${expr(e.max)})`;
    case 'call':
      return `${ref(e.callee)}${e.attrs ? ` ${attrs(e.attrs)}` : ''}(${e.args.map((a) => expr(a)).join(', ')})`;
    case 'syscall':
      return e.args.length > 0 || e.parens ? `${e.name}(${e.args.map((a) => expr(a)).join(', ')})` : e.name;
  }
}

/** A value that may be `min : typ : max` without parentheses. */
function mtm(e: A.Expr): string {
  return e.kind === 'mintypmax' ? `${expr(e.min)} : ${expr(e.typ)} : ${expr(e.max)}` : expr(e);
}

function delay(d: A.DelayList): string {
  const only = d.values.length === 1 ? d.values[0]! : undefined;
  if (only && (only.kind === 'number' || only.kind === 'real' || only.kind === 'ident' || only.kind === 'hier')) return `#${expr(only)}`;
  return `#(${d.values.map(mtm).join(', ')})`;
}

function range(r: A.RangeSpec): string {
  return `[${expr(r.msb)}:${expr(r.lsb)}]`;
}

function drive(d: A.DriveStrength): string {
  return d.second ? `(${d.first}, ${d.second})` : `(${d.first})`;
}

function events(ev: A.EventTerm[] | 'star'): string {
  if (ev === 'star') return '@*';
  return `@(${ev.map((t) => (t.edge === 'pos' ? 'posedge ' : t.edge === 'neg' ? 'negedge ' : '') + expr(t.expr)).join(' or ')})`;
}

function control(c: A.TimingControl): string {
  switch (c.kind) {
    case 'delay':
      return delay(c.delay);
    case 'event':
      return events(c.events);
    case 'repeatEvent':
      return `repeat (${expr(c.count)}) ${events(c.event.events)}`;
  }
}

function endsWithDanglingIf(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'if':
      return s.else ? endsWithDanglingIf(s.else) : true;
    case 'for':
    case 'while':
    case 'repeat':
    case 'forever':
    case 'wait':
    case 'timing':
      return endsWithDanglingIf(s.body);
    default:
      return false;
  }
}

class Printer {
  private readonly lines: string[] = [];
  private level = 0;

  write(text: string) {
    this.lines.push(`${'  '.repeat(this.level)}${text}`);
  }
  indented(f: () => void) {
    this.level++;
    f();
    this.level--;
  }
  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }

  // ------------------------------------------------------------ statements

  /** `header` and then `body`: a block opens on the header's line, anything else goes on the next line. */
  private after(header: string, body: A.Stmt) {
    if (body.kind === 'block' && !body.attrs) {
      this.block(header, body);
    } else if (body.kind === 'empty' && !body.attrs) {
      this.write(`${header} ;`);
    } else {
      this.write(header);
      this.indented(() => this.stmt(body));
    }
  }

  private block(header: string, b: A.BlockStmt) {
    this.write(`${header ? `${header} ` : ''}${b.parallel ? 'fork' : 'begin'}${b.name ? ` : ${name(b.name)}` : ''}`);
    this.indented(() => {
      for (const d of b.decls) this.decl(d);
      for (const s of b.stmts) this.stmt(s);
    });
    this.write(b.parallel ? 'join' : 'end');
  }

  stmt(s: A.Stmt, prefix = '') {
    const pre = prefix + attrs(s.attrs);
    switch (s.kind) {
      case 'empty':
        this.write(`${pre};`);
        return;
      case 'block':
        this.block(pre.trimEnd(), s);
        return;
      case 'if': {
        const guard = s.else && endsWithDanglingIf(s.then);
        const header = `${pre}if (${expr(s.cond)})`;
        if (guard) {
          this.write(`${header} begin`);
          this.indented(() => this.stmt(s.then));
          this.write('end');
        } else this.after(header, s.then);
        if (s.else) {
          if (s.else.kind === 'if' && !s.else.attrs) this.stmt(s.else, 'else ');
          else this.after('else', s.else);
        }
        return;
      }
      case 'assign': {
        const op = s.blocking ? '=' : '<=';
        this.write(`${pre}${expr(s.lhs)} ${op} ${s.control ? `${control(s.control)} ` : ''}${expr(s.rhs)};`);
        return;
      }
      case 'case': {
        this.write(`${pre}${s.flavor} (${expr(s.expr)})`);
        this.indented(() => {
          for (const it of s.items) {
            const head = it.labels ? `${it.labels.map((l) => expr(l)).join(', ')}:` : 'default:';
            this.after(head, it.body);
          }
        });
        this.write('endcase');
        return;
      }
      case 'for':
        this.after(`${pre}for (${expr(s.init.lhs)} = ${expr(s.init.rhs)}; ${expr(s.cond)}; ${expr(s.step.lhs)} = ${expr(s.step.rhs)})`, s.body);
        return;
      case 'while':
        this.after(`${pre}while (${expr(s.cond)})`, s.body);
        return;
      case 'repeat':
        this.after(`${pre}repeat (${expr(s.count)})`, s.body);
        return;
      case 'forever':
        this.after(`${pre}forever`, s.body);
        return;
      case 'wait':
        this.after(`${pre}wait (${expr(s.cond)})`, s.body);
        return;
      case 'timing':
        this.after(`${pre}${control(s.control)}`, s.body);
        return;
      case 'trigger':
        this.write(`${pre}-> ${expr(s.event)};`);
        return;
      case 'disable':
        this.write(`${pre}disable ${ref(s.target)};`);
        return;
      case 'procAssign':
        this.write(`${pre}${s.op} ${expr(s.lhs)}${s.rhs ? ` = ${expr(s.rhs)}` : ''};`);
        return;
      case 'taskCall':
        this.write(`${pre}${ref(s.callee)}${s.parens || s.args.length > 0 ? `(${s.args.map((a) => expr(a)).join(', ')})` : ''};`);
        return;
      case 'sysTask':
        this.write(`${pre}${s.name}${s.parens || s.args.length > 0 ? `(${s.args.map((a) => (a ? expr(a) : '')).join(', ')})` : ''};`);
        return;
    }
  }

  // ------------------------------------------------------------ declarations

  private declarators(list: A.Declarator[]): string {
    return list.map((d) => name(d.name) + d.dims.map((r) => ` ${range(r)}`).join('') + (d.init ? ` = ${expr(d.init)}` : '')).join(', ');
  }

  private decl(d: A.BlockDecl | A.SpecparamDecl) {
    switch (d.kind) {
      case 'netDecl': {
        const parts: string[] = [d.net];
        if (d.drive) parts.push(drive(d.drive));
        if (d.charge) parts.push(`(${d.charge})`);
        if (d.vectored) parts.push(d.vectored);
        if (d.signed) parts.push('signed');
        if (d.range) parts.push(range(d.range));
        if (d.delay) parts.push(delay(d.delay));
        this.write(`${attrs(d.attrs)}${parts.join(' ')} ${this.declarators(d.declarators)};`);
        return;
      }
      case 'paramDecl':
        this.write(`${attrs(d.attrs)}${this.paramHead(d)} ${d.assigns.map((a) => `${name(a.name)} = ${mtm(a.value)}`).join(', ')};`);
        return;
      case 'portDecl': {
        const parts: string[] = [d.dir];
        if (d.net) parts.push(d.net);
        if (d.signed) parts.push('signed');
        if (d.range) parts.push(range(d.range));
        this.write(`${attrs(d.attrs)}${parts.join(' ')} ${d.names.map((n) => name(n.name) + (n.init ? ` = ${expr(n.init)}` : '')).join(', ')};`);
        return;
      }
      case 'specparamDecl':
        this.write(`${attrs(d.attrs)}specparam ${d.range ? `${range(d.range)} ` : ''}${d.assigns.map((a) => `${name(a.name)} = ${'values' in a.value ? `(${a.value.values.map(mtm).join(', ')})` : mtm(a.value)}`).join(', ')};`);
        return;
    }
  }

  private paramHead(d: A.ParamDecl): string {
    const parts: string[] = [d.local ? 'localparam' : 'parameter'];
    if (d.type) parts.push(d.type);
    else {
      if (d.signed) parts.push('signed');
      if (d.range) parts.push(range(d.range));
    }
    return parts.join(' ');
  }

  // ------------------------------------------------------------ module items

  private conns(i: A.Instance, label: string): string {
    if (i.ordered) return `${label} (${i.ordered.map((c) => attrs(c.attrs) + (c.expr ? expr(c.expr) : '')).join(', ')})`;
    return `${label} (${i.conns.map((c) => `${attrs(c.attrs)}.${name(c.port)}(${c.expr ? expr(c.expr) : ''})`).join(', ')})`;
  }

  private generateBlock(header: string, b: A.GenerateBlock) {
    if (b.explicit) {
      this.write(`${header} begin${b.name ? ` : ${name(b.name)}` : ''}`);
      this.indented(() => b.items.forEach((it) => this.item(it)));
      this.write('end');
    } else if (b.items.length === 0) this.write(`${header} ;`);
    else {
      this.write(header);
      this.indented(() => b.items.forEach((it) => this.item(it)));
    }
  }

  private tfPorts(ports: A.TfPort[]): string {
    return `(${ports
      .map((p) => {
        const parts: string[] = [p.dir];
        if (p.net) parts.push(p.net);
        if (p.signed) parts.push('signed');
        if (p.range) parts.push(range(p.range));
        parts.push(name(p.name));
        return attrs(p.attrs) + parts.join(' ');
      })
      .join(', ')})`;
  }

  private item(it: A.ModuleItem) {
    const a = attrs(it.attrs);
    switch (it.kind) {
      case 'netDecl':
      case 'paramDecl':
      case 'specparamDecl':
      case 'portDecl':
        this.decl(it);
        return;
      case 'genvarDecl':
        this.write(`${a}genvar ${it.names.map(name).join(', ')};`);
        return;
      case 'defparam':
        this.write(`${a}defparam ${it.assigns.map((x) => `${ref(x.target)} = ${mtm(x.value)}`).join(', ')};`);
        return;
      case 'continuousAssign':
        this.write(`${a}assign ${it.drive ? `${drive(it.drive)} ` : ''}${it.delay ? `${delay(it.delay)} ` : ''}${expr(it.lhs)} = ${expr(it.rhs)};`);
        return;
      case 'always':
        if (it.events !== undefined) this.after(`${a}always ${events(it.events)}`, it.body);
        else this.after(`${a}always`, it.body);
        return;
      case 'initial':
        this.after(`${a}initial`, it.body);
        return;
      case 'instance': {
        let head = `${a}${name(it.module)}`;
        if (it.params) {
          head +=
            it.params.style === 'named'
              ? ` #(${it.params.items.map((p) => `.${name(p.name)}(${p.value ? mtm(p.value) : ''})`).join(', ')})`
              : ` #(${it.params.items.map(mtm).join(', ')})`;
        }
        if (it.drive) head += ` ${drive(it.drive)}`;
        const label = `${it.name ? ` ${name(it.name)}` : ''}${it.range ? ` ${range(it.range)}` : ''}`;
        this.write(`${head}${this.conns(it, label)};`);
        return;
      }
      case 'gate': {
        const label = `${it.name ? ` ${name(it.name)}` : ''}${it.range ? ` ${range(it.range)}` : ''}`;
        this.write(`${a}${it.gate}${it.drive ? ` ${drive(it.drive)}` : ''}${it.delay ? ` ${delay(it.delay)}` : ''}${label} (${it.terminals.map((t) => expr(t)).join(', ')});`);
        return;
      }
      case 'generateRegion':
        this.write(`${a}generate`);
        this.indented(() => it.items.forEach((x) => this.item(x)));
        this.write('endgenerate');
        return;
      case 'generateFor':
        this.generateBlock(`${a}for (${name(it.init.genvar)} = ${expr(it.init.value)}; ${expr(it.cond)}; ${name(it.step.genvar)} = ${expr(it.step.value)})`, it.body);
        return;
      case 'generateIf':
        this.generateBlock(`${a}if (${expr(it.cond)})`, it.then);
        if (it.else) this.generateBlock('else', it.else);
        return;
      case 'generateCase':
        this.write(`${a}case (${expr(it.expr)})`);
        this.indented(() => {
          for (const c of it.items) this.generateBlock(c.labels ? `${c.labels.map((l) => expr(l)).join(', ')}:` : 'default:', c.body);
        });
        this.write('endcase');
        return;
      case 'function': {
        const parts: string[] = ['function'];
        if (it.automatic) parts.push('automatic');
        if (it.type === 'reg') parts.push('reg');
        if (it.signed) parts.push('signed');
        if (it.range) parts.push(range(it.range));
        else if (it.type && it.type !== 'reg') parts.push(it.type);
        parts.push(name(it.name));
        this.write(`${a}${parts.join(' ')}${it.ansi ? ` ${this.tfPorts(it.ports)}` : ''};`);
        this.indented(() => {
          for (const d of it.decls) this.decl(d);
          this.stmt(it.body);
        });
        this.write('endfunction');
        return;
      }
      case 'task':
        this.write(`${a}task${it.automatic ? ' automatic' : ''} ${name(it.name)}${it.ansi ? ` ${this.tfPorts(it.ports)}` : ''};`);
        this.indented(() => {
          for (const d of it.decls) this.decl(d);
          this.stmt(it.body);
        });
        this.write('endtask');
        return;
      case 'specify':
        this.write(`${a}specify`);
        this.indented(() => it.items.forEach((x) => this.specifyItem(x)));
        this.write('endspecify');
        return;
    }
  }

  private specifyItem(it: A.SpecifyItem) {
    switch (it.kind) {
      case 'specparamDecl':
        this.decl(it);
        return;
      case 'pulseStyle':
        this.write(`${it.style} ${it.outputs.map((o) => expr(o)).join(', ')};`);
        return;
      case 'path': {
        const cond = !it.cond ? '' : it.cond.kind === 'if' ? `if (${expr(it.cond.expr)}) ` : 'ifnone ';
        const outs = it.outputs.map((o) => expr(o)).join(', ');
        const out = it.dataSource ? `(${outs} ${it.outPolarity ?? ''}: ${expr(it.dataSource)})` : outs;
        const delays = it.delays.length === 1 && it.delays[0]!.kind !== 'mintypmax' ? mtm(it.delays[0]!) : it.delays.length === 1 ? `(${mtm(it.delays[0]!)})` : `(${it.delays.map(mtm).join(', ')})`;
        this.write(`${cond}(${it.edge ? `${it.edge} ` : ''}${it.inputs.map((o) => expr(o)).join(', ')} ${it.inPolarity ?? ''}${it.connection} ${out}) = ${delays};`);
        return;
      }
      case 'timingCheck': {
        const args = it.args.map((arg) => {
          if (!arg) return '';
          const edge = arg.edge === 'edge' ? `edge [${(arg.descriptors ?? []).join(', ')}] ` : arg.edge ? `${arg.edge} ` : '';
          return `${edge}${mtm(arg.expr)}${arg.cond ? ` &&& ${expr(arg.cond)}` : ''}`;
        });
        this.write(`${it.name}(${args.join(', ')});`);
        return;
      }
    }
  }

  // ------------------------------------------------------------ units

  private modulePorts(m: A.ModuleDecl): string {
    if (m.portStyle === 'none') return '';
    if (m.portStyle === 'ansi') {
      return ` (${m.ports
        .map((p) => {
          const parts: string[] = [p.dir];
          if (p.net) parts.push(p.net);
          if (p.signed) parts.push('signed');
          if (p.range) parts.push(range(p.range));
          parts.push(name(p.name));
          return `${attrs(p.attrs)}${parts.join(' ')}${p.init ? ` = ${expr(p.init)}` : ''}`;
        })
        .join(', ')})`;
    }
    const refs = (p: A.NonAnsiPort) => {
      const text = p.refs.map((r) => name(r.name) + (r.select ? select(r.select.hi, r.select.lo, r.select.mode) : '')).join(', ');
      return p.braced ? `{${text}}` : text;
    };
    return ` (${m.portList.map((p) => (p.external ? `.${name(p.external)}(${refs(p)})` : refs(p))).join(', ')})`;
  }

  module(m: A.ModuleDecl) {
    const params = m.paramPorts
      ? ` #(${m.paramPorts
          .map((p) => {
            const a = p.assigns[0]!;
            return `${attrs(p.attrs)}${this.paramHead(p)} ${name(a.name)} = ${mtm(a.value)}`;
          })
          .join(', ')})`
      : '';
    this.write(`${attrs(m.attrs)}${m.macro ? 'macromodule' : 'module'} ${name(m.name)}${params}${this.modulePorts(m)};`);
    this.indented(() => m.items.forEach((it) => this.item(it)));
    this.write('endmodule');
  }

  udp(u: A.UdpDecl) {
    const port = (p: A.UdpPort) => `${p.dir}${p.reg ? ' reg' : ''} ${name(p.name)}${p.init ? ` = ${expr(p.init)}` : ''}`;
    this.write(`${attrs(u.attrs)}primitive ${name(u.name)} (${u.ansi ? u.ports.map(port).join(', ') : u.names.map(name).join(', ')});`);
    this.indented(() => {
      for (const d of u.decls) {
        this.write(`${attrs(d.attrs)}${d.kind}${d.reg ? ' reg' : ''} ${d.names.map((n) => name(n.name) + (n.init ? ` = ${expr(n.init)}` : '')).join(', ')};`);
      }
      if (u.init) this.write(`initial ${name(u.init.name)} = ${expr(u.init.value)};`);
      this.write('table');
      this.indented(() => {
        for (const e of u.entries) this.write(`${e.inputs.join(' ')} : ${e.current !== undefined ? `${e.current} : ` : ''}${e.next};`);
      });
      this.write('endtable');
    });
    this.write('endprimitive');
  }

  config(c: A.ConfigDecl) {
    const cell = (r: A.CellRef) => (r.lib ? `${name(r.lib)}.${name(r.cell)}` : name(r.cell));
    const use = (u: { cell: A.CellRef; config: boolean }) => `use ${cell(u.cell)}${u.config ? ':config' : ''}`;
    this.write(`${attrs(c.attrs)}config ${name(c.name)};`);
    this.indented(() => {
      this.write(`design ${c.design.map(cell).join(' ')};`);
      for (const r of c.rules) {
        if (r.kind === 'default') this.write(`default liblist ${r.liblist.map(name).join(' ')};`);
        else if (r.kind === 'instance') this.write(`instance ${r.path.map(name).join('.')} ${r.use ? use(r.use) : `liblist ${(r.liblist ?? []).map(name).join(' ')}`};`);
        else this.write(`cell ${cell(r.cell)} ${r.use ? use(r.use) : `liblist ${(r.liblist ?? []).map(name).join(' ')}`};`);
      }
    });
    this.write('endconfig');
  }
}

/** Write a whole file as Verilog text. */
export function print(file: A.SourceFile): string {
  const p = new Printer();
  file.units.forEach((u, i) => {
    if (i > 0) p.write('');
    if (u.kind === 'module') p.module(u);
    else if (u.kind === 'udp') p.udp(u);
    else p.config(u);
  });
  return p.toString();
}

export { expr as printExpr };
export function printStmt(s: A.Stmt): string {
  const p = new Printer();
  p.stmt(s);
  return p.toString();
}
