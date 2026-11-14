import { KEYWORDS } from '@ihatecircuits/hdl';
import { powerOnProp } from './ctx';
import { type Circuit, type Component, type PinDef, type Project, getDef, portNames, portsOf, splitterMap, useProject } from './core';

/**
 * Structural Verilog for an iHateCircuits project.
 *
 * Every circuit becomes a module, every part becomes one `assign`, one
 * register block or one instance, and every net becomes a named wire. The
 * output is plain Verilog-2005 any simulator accepts.
 *
 * Supported parts: pin, const, not, and, or, nand, nor, xor, xnor, adder, subtractor,
 * multiplier, divider (without Hi), negator, comparator, shifter (shifts only), mux,
 * splitter, junction, pull, extender (zero, one or sign fill), tribuf, register (rising or
 * falling edge, optional EN and CLR), dff (optional SET and CLR), dlatch, rom, ram (one
 * clock, separate data pins, asynchronous read) and subcircuits. Anything else, and
 * options these parts have that Verilog cannot say plainly (inverted inputs, open-drain
 * outputs), throws ExportError instead of being exported wrongly.
 *
 * Asynchronous CLR and SET are level sensitive in the circuit, so they are written that
 * way here too: the state register loads on the clock and the output is
 * `clr ? 0 : set ? 1 : state`, which also reads right when the reset is active from time
 * 0 (a `posedge clr` block would miss that).
 *
 * Known differences when the result is simulated: the library adder is more
 * precise than Verilog's `+` on unknown inputs, a divider divides by zero as all ones
 * where Verilog gives x, and library registers power on at 0 where a Verilog reg starts as x
 * (a register, flip-flop or latch with an `init` property is declared with that value instead: `reg q = 4'b0101;`).
 * None of these affects 0/1 behaviour away from a division by zero.
 */

export class ExportError extends Error {}

type Slot = string;
const slot = (comp: string, pin: string): Slot => `${comp}.${pin}`;

class UnionFind {
  private parent = new Map<Slot, Slot>();
  find(a: Slot): Slot {
    let p = this.parent.get(a);
    if (p === undefined) {
      this.parent.set(a, a);
      return a;
    }
    while (p !== this.parent.get(p)) p = this.parent.get(p)!;
    this.parent.set(a, p);
    return p;
  }
  union(a: Slot, b: Slot) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const byNumber = (a: Component, b: Component) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function identifier(raw: string, taken: Set<string>): string {
  let s = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = `p_${s}`;
  if (KEYWORDS.has(s)) s = `${s}_`;
  let name = s;
  for (let i = 2; taken.has(name); i++) name = `${s}_${i}`;
  taken.add(name);
  return name;
}

const unknownBits = (w: number) => `${w}'b${'x'.repeat(w)}`;
const range = (name: string, width: number, hi: number, lo: number) => (width === 1 ? name : hi === width - 1 && lo === 0 ? name : hi === lo ? `${name}[${hi}]` : `${name}[${hi}:${lo}]`);
const decl = (width: number) => (width === 1 ? '' : `[${width - 1}:0] `);

function exportCircuit(c: Circuit, project: Project, moduleNames: Map<string, string>, portIdents: Map<string, Map<string, string>>): string {
  const comps = Object.values(c.components).sort(byNumber);
  const uf = new UnionFind();
  const pinsOfComp = new Map<string, PinDef[]>();
  for (const comp of comps) {
    const def = comp.type.startsWith('sub:') ? undefined : getDef(comp.type);
    if (!comp.type.startsWith('sub:') && !SUPPORTED.has(comp.type)) {
      throw new ExportError(`The part '${def!.name}' (${comp.type}) in circuit '${c.name}' cannot be exported to Verilog.`);
    }
    const pins = getDef(comp.type).pins(comp.type.startsWith('sub:') ? {} : comp.props);
    pinsOfComp.set(comp.id, pins);
    for (const p of pins) uf.find(slot(comp.id, p.name));
  }
  for (const w of Object.values(c.wires)) uf.union(slot(w.from.comp, w.from.pin), slot(w.to.comp, w.to.pin));

  const wired = new Set<Slot>();
  for (const w of Object.values(c.wires)) {
    wired.add(slot(w.from.comp, w.from.pin));
    wired.add(slot(w.to.comp, w.to.pin));
  }
  const isWired = (comp: Component, pin: string) => wired.has(slot(comp.id, pin));

  // Nets and their names.
  const idents = portIdents.get(c.id)!;
  const taken = new Set<string>(idents.values());
  const netWidth = new Map<Slot, number>();
  for (const comp of comps) for (const p of pinsOfComp.get(comp.id)!) if (p.width > 0) netWidth.set(uf.find(slot(comp.id, p.name)), Math.max(netWidth.get(uf.find(slot(comp.id, p.name))) ?? 0, p.width));
  const netName = new Map<Slot, string>();
  const pinComps = comps.filter((x) => x.type === 'pin');
  const names = portNames(c);
  for (const p of pinComps.filter((x) => x.props.io !== 'out')) {
    const root = uf.find(slot(p.id, 'p'));
    if (netName.has(root)) throw new ExportError(`Two input pins in circuit '${c.name}' are wired together.`);
    netName.set(root, idents.get(names.get(p.id)!)!);
  }
  const nameOf = (comp: Component, pin: string): string => {
    const root = uf.find(slot(comp.id, pin));
    let n = netName.get(root);
    if (!n) {
      n = identifier(`n${netName.size}`, taken);
      netName.set(root, n);
    }
    return n;
  };
  const widthOf = (comp: Component, pin: string) => netWidth.get(uf.find(slot(comp.id, pin))) ?? 1;
  /** The net on a pin as an operand, or `fallback` when nothing is wired to it. */
  const operand = (comp: Component, pin: string, fallback: string) => (isWired(comp, pin) ? nameOf(comp, pin) : fallback);

  // Which nets have a driver. Splitters pass drivers across: bus to branches, or branches to bus.
  const driven = new Set<Slot>();
  for (const comp of comps) {
    if (comp.type === 'splitter') continue;
    if (comp.type === 'pin') {
      if (comp.props.io !== 'out') driven.add(uf.find(slot(comp.id, 'p')));
      continue;
    }
    for (const p of pinsOfComp.get(comp.id)!) if (p.dir === 'out') driven.add(uf.find(slot(comp.id, p.name)));
  }
  const splitters = comps.filter((x) => x.type === 'splitter');
  type SplitterDir = 'fan-out' | 'fan-in';
  const direction = new Map<string, SplitterDir>();
  const spread = () => {
    for (let progress = true; progress; ) {
      progress = false;
      for (const s of splitters) {
        if (direction.has(s.id)) continue;
        const fans = pinsOfComp.get(s.id)!.filter((p) => p.name !== 'c');
        const bus = uf.find(slot(s.id, 'c'));
        if (driven.has(bus)) {
          direction.set(s.id, 'fan-out');
          for (const f of fans) driven.add(uf.find(slot(s.id, f.name)));
          progress = true;
        } else if (fans.some((f) => isWired(s, f.name) && driven.has(uf.find(slot(s.id, f.name))))) {
          direction.set(s.id, 'fan-in');
          driven.add(bus);
          progress = true;
        }
      }
    }
  };
  spread();
  // A splitter reading a bus that nothing drives (an undriven signal) still splits it, into floating branches.
  for (let again = true; again; ) {
    again = false;
    const open = splitters.find((s) => !direction.has(s.id) && isWired(s, 'c'));
    if (open) {
      direction.set(open.id, 'fan-out');
      for (const f of pinsOfComp.get(open.id)!.filter((p) => p.name !== 'c')) driven.add(uf.find(slot(open.id, f.name)));
      spread();
      again = true;
    }
  }

  const header: string[] = [];
  const decls: string[] = [];
  const body: string[] = [];
  const mod = moduleNames.get(c.id)!;
  const { inputs, outputs } = portsOf(c);
  for (const p of inputs) header.push(`input ${decl(Number(p.props.bits ?? 1))}${idents.get(names.get(p.id)!)}`);
  for (const p of outputs) header.push(`output ${decl(Number(p.props.bits ?? 1))}${idents.get(names.get(p.id)!)}`);

  const pulled = new Map<Slot, string>();
  for (const comp of comps) if (comp.type === 'pull') pulled.set(uf.find(slot(comp.id, 'p')), comp.props.pull === 'down' ? 'tri0' : 'tri1');
  // A simulator counts the clock going from x to 0 at power-on as a falling edge, when nets are still settling and a register
  // would load x. Blocks on a falling edge wait until time 1, after the testbench has applied its first values.
  const live = identifier('live', taken);
  let usesLive = false;
  const always = (edge: string, clk: string, stmt: string) => {
    if (edge !== 'negedge') return `  always @(${edge} ${clk}) ${stmt}`;
    usesLive = true;
    return `  always @(${edge} ${clk}) if (${live}) ${stmt}`;
  };
  const declared = new Set<Slot>();
  const declareNet = (comp: Component, pin: string): string => {
    const name = nameOf(comp, pin);
    const root = uf.find(slot(comp.id, pin));
    if (!declared.has(root) && !pinComps.some((x) => x.props.io !== 'out' && uf.find(slot(x.id, 'p')) === root)) {
      declared.add(root);
      decls.push(`  ${pulled.get(root) ?? 'wire'} ${decl(widthOf(comp, pin))}${name};`);
    }
    return name;
  };

  for (const comp of comps) {
    const props = comp.props;
    const bits = Number(props.bits ?? 1);
    const out = (pin: string) => declareNet(comp, pin);
    switch (comp.type) {
      case 'pin': {
        if (props.io === 'out' && isWired(comp, 'p')) body.push(`  assign ${idents.get(names.get(comp.id)!)} = ${declareNet(comp, 'p')};`);
        break;
      }
      case 'junction': {
        // A bare net. When nothing drives it the exported wire floats (z), as the circuit does.
        if (isWired(comp, 'p')) declareNet(comp, 'p');
        break;
      }
      case 'const': {
        if (!isWired(comp, 'out')) break;
        const hex = String(props.value ?? '0').toUpperCase();
        body.push(`  assign ${out('out')} = ${bits}'h${hex};`);
        break;
      }
      case 'not': {
        if (!isWired(comp, 'out')) break;
        body.push(`  assign ${out('out')} = ~${operand(comp, 'in0', unknownBits(bits))};`);
        break;
      }
      case 'and':
      case 'or':
      case 'nand':
      case 'nor':
      case 'xor':
      case 'xnor': {
        if (String(props.negate ?? '') !== '' || (props.output ?? '01') !== '01') throw new ExportError(`The ${comp.type} gate in circuit '${c.name}' uses inverted inputs or an open-drain output, which cannot be exported.`);
        if (comp.type === 'xor' || comp.type === 'xnor') if (Number(props.inputs ?? 2) > 2 && props.multi === 'one') throw new ExportError(`The ${comp.type} gate in circuit '${c.name}' is set to 'exactly one', which cannot be exported.`);
        if (!isWired(comp, 'out')) break;
        const n = Number(props.inputs ?? 2);
        const ins = Array.from({ length: n }, (_, i) => `in${i}`).filter((p) => isWired(comp, p)).map((p) => nameOf(comp, p));
        const op = { and: '&', nand: '&', or: '|', nor: '|', xor: '^', xnor: '^' }[comp.type];
        const neg = comp.type === 'nand' || comp.type === 'nor' || comp.type === 'xnor';
        let expr = ins.length ? ins.join(` ${op} `) : unknownBits(bits);
        if (ins.length && neg) expr = `~(${expr})`;
        body.push(`  assign ${out('out')} = ${expr};`);
        break;
      }
      case 'adder': {
        const w = bits;
        const a = operand(comp, 'a', unknownBits(w));
        const b = operand(comp, 'b', unknownBits(w));
        const carry = isWired(comp, 'cin') ? ` + ${nameOf(comp, 'cin')}` : '';
        if (!isWired(comp, 's') && !isWired(comp, 'cout')) break;
        const sum = identifier(`sum${comp.id}`, taken);
        decls.push(`  wire [${w}:0] ${sum};`);
        body.push(`  assign ${sum} = ${a} + ${b}${carry};`);
        if (isWired(comp, 's')) body.push(`  assign ${out('s')} = ${range(sum, w + 1, w - 1, 0)};`);
        if (isWired(comp, 'cout')) body.push(`  assign ${out('cout')} = ${sum}[${w}];`);
        break;
      }
      case 'mux': {
        if (props.enable) throw new ExportError(`The multiplexer in circuit '${c.name}' has an enable pin, which cannot be exported.`);
        if (!isWired(comp, 'y')) break;
        const selBits = Number(props.sel ?? 1);
        const sel = operand(comp, 's', unknownBits(selBits));
        const data = (i: number) => operand(comp, `d${i}`, unknownBits(bits));
        let expr = `${sel} ? ${data(1)} : ${data(0)}`;
        if (selBits > 1) {
          expr = data((1 << selBits) - 1);
          for (let i = (1 << selBits) - 2; i >= 0; i--) expr = `${sel} == ${selBits}'d${i} ? ${data(i)} : ${expr}`;
        }
        body.push(`  assign ${out('y')} = ${expr};`);
        break;
      }
      case 'splitter': {
        const dir = direction.get(comp.id);
        if (!dir) break;
        const total = Number(props.width ?? 4);
        const fansDef = pinsOfComp.get(comp.id)!.filter((p) => p.name !== 'c');
        const map = splitterMap({ ...props }, fansDef.length);
        const busBits = (fan: number) => map.flatMap((f, i) => (f === fan ? [i] : []));
        if (dir === 'fan-out') {
          // Declared here as well: a bus nothing drives has no other declaration and floats.
          const bus = declareNet(comp, 'c');
          fansDef.forEach((f, k) => {
            if (!isWired(comp, f.name)) return;
            const idx = busBits(k);
            const contiguous = idx.every((b, i) => i === 0 || b === idx[i - 1]! + 1);
            const expr = contiguous ? range(bus, total, idx.at(-1)!, idx[0]!) : `{${[...idx].reverse().map((b) => (total === 1 ? bus : `${bus}[${b}]`)).join(', ')}}`;
            body.push(`  assign ${out(f.name)} = ${expr};`);
          });
        } else {
          const pieces: string[] = [];
          for (let i = total - 1; i >= 0; i--) {
            const k = map[i]!;
            if (k < 0 || !isWired(comp, fansDef[k]!.name)) {
              pieces.push("1'bz");
              continue;
            }
            const j = busBits(k).indexOf(i);
            const fanWidth = widthOf(comp, fansDef[k]!.name);
            pieces.push(fanWidth === 1 ? nameOf(comp, fansDef[k]!.name) : `${nameOf(comp, fansDef[k]!.name)}[${j}]`);
          }
          body.push(`  assign ${out('c')} = {${pieces.join(', ')}};`);
        }
        break;
      }
      case 'extender': {
        if (!isWired(comp, 'out')) break;
        const wi = Number(props.inBits ?? 4);
        const wo = Number(props.outBits ?? 8);
        const input = operand(comp, 'in', unknownBits(wi));
        let expr: string;
        if (wo === wi) expr = input;
        else if (wo < wi) expr = range(input, wi, wo - 1, 0);
        else if (props.fill === 'zero' || props.fill === undefined) expr = `{${wo - wi}'b${'0'.repeat(wo - wi)}, ${input}}`;
        else if (props.fill === 'one') expr = `{${wo - wi}'b${'1'.repeat(wo - wi)}, ${input}}`;
        else if (props.fill === 'sign') expr = `{${Array(wo - wi).fill(wi === 1 ? input : `${input}[${wi - 1}]`).join(', ')}, ${input}}`;
        else throw new ExportError(`The bit extender in circuit '${c.name}' takes its fill from an input, which cannot be exported.`);
        body.push(`  assign ${out('out')} = ${expr};`);
        break;
      }
      case 'register': {
        if (props.trigger === 'high' || props.trigger === 'low') throw new ExportError(`The register in circuit '${c.name}' is level triggered, which cannot be exported.`);
        if (!isWired(comp, 'clk')) throw new ExportError(`A register in circuit '${c.name}' has no clock connected.`);
        const reg = identifier(`reg${comp.id}`, taken);
        decls.push(`  reg ${decl(bits)}${reg}${initOf(props.init, bits)};`);
        const edge = props.trigger === 'falling' ? 'negedge' : 'posedge';
        const d = operand(comp, 'd', unknownBits(bits));
        if (isWired(comp, 'clr')) {
          // An asynchronous clear is level sensitive: it wins over the clock, and an unknown clear merges 0 with the held value.
          const clr = nameOf(comp, 'clr');
          const next = isWired(comp, 'en') ? `${nameOf(comp, 'en')} ? ${d} : ${reg}` : d;
          body.push(always(edge, nameOf(comp, 'clk'), `${reg} <= ${clr} ? ${bits}'d0 : (${next});`));
          if (isWired(comp, 'q')) body.push(`  assign ${out('q')} = ${clr} ? ${bits}'d0 : ${reg};`);
          break;
        }
        const load = isWired(comp, 'en') ? `if (${nameOf(comp, 'en')}) ${reg} <= ${d};` : `${reg} <= ${d};`;
        body.push(always(edge, nameOf(comp, 'clk'), `${load}`));
        if (isWired(comp, 'q')) body.push(`  assign ${out('q')} = ${reg};`);
        break;
      }
      case 'dff': {
        if (props.trigger === 'high' || props.trigger === 'low') throw new ExportError(`The flip-flop in circuit '${c.name}' is level triggered, which cannot be exported.`);
        if (!isWired(comp, 'clk')) throw new ExportError(`A flip-flop in circuit '${c.name}' has no clock connected.`);
        const reg = identifier(`ff${comp.id}`, taken);
        decls.push(`  reg ${reg}${initOf(props.init, 1)};`);
        const edge = props.trigger === 'falling' ? 'negedge' : 'posedge';
        let next = operand(comp, 'd', unknownBits(1));
        let shown = reg;
        if (isWired(comp, 'set')) {
          next = `${nameOf(comp, 'set')} ? 1'b1 : (${next})`;
          shown = `${nameOf(comp, 'set')} ? 1'b1 : ${shown}`;
        }
        if (isWired(comp, 'clr')) {
          next = `${nameOf(comp, 'clr')} ? 1'b0 : (${next})`;
          shown = `${nameOf(comp, 'clr')} ? 1'b0 : (${shown})`;
        }
        body.push(always(edge, nameOf(comp, 'clk'), `${reg} <= ${next};`));
        if (isWired(comp, 'q')) body.push(`  assign ${out('q')} = ${shown};`);
        if (isWired(comp, 'qn')) body.push(`  assign ${out('qn')} = ~(${shown});`);
        break;
      }
      case 'dlatch': {
        const reg = identifier(`latch${comp.id}`, taken);
        decls.push(`  reg ${reg}${initOf(props.init, 1)};`);
        const en = operand(comp, 'en', "1'bx");
        const d = operand(comp, 'd', unknownBits(1));
        // As for a falling edge: a latch holding a power-on value must not merge it away while the nets are still settling and the
        // enable reads x, so the merge waits until time 1. A known enable acts at once.
        const holds = powerOnProp(String(props.init ?? '')) !== undefined;
        if (holds) usesLive = true;
        body.push(`  always @* if (${en} === 1'b1) ${reg} = ${d}; else if (${en} !== 1'b0${holds ? ` && ${live}` : ''}) ${reg} = ${en} ? ${d} : ${reg};`);
        if (isWired(comp, 'q')) body.push(`  assign ${out('q')} = ${reg};`);
        if (isWired(comp, 'qn')) body.push(`  assign ${out('qn')} = ~${reg};`);
        break;
      }
      case 'tribuf': {
        if (!isWired(comp, 'out')) break;
        const en = operand(comp, 'en', "1'bx");
        const high = props.enable !== 'low';
        const on = high ? "1'b1" : "1'b0";
        const off = high ? "1'b0" : "1'b1";
        body.push(`  assign ${out('out')} = ${en} === ${on} ? ${operand(comp, 'in0', unknownBits(bits))} : ${en} === ${off} ? ${bits}'bz : ${unknownBits(bits)};`);
        break;
      }
      case 'pull': {
        if (isWired(comp, 'p')) declareNet(comp, 'p');
        break;
      }
      case 'subtractor': {
        const w = bits;
        if (!isWired(comp, 'd') && !isWired(comp, 'bout')) break;
        const diff = identifier(`diff${comp.id}`, taken);
        decls.push(`  wire [${w}:0] ${diff};`);
        const borrow = isWired(comp, 'bin') ? ` - ${nameOf(comp, 'bin')}` : '';
        body.push(`  assign ${diff} = {1'b0, ${operand(comp, 'a', unknownBits(w))}} - {1'b0, ${operand(comp, 'b', unknownBits(w))}}${borrow};`);
        if (isWired(comp, 'd')) body.push(`  assign ${out('d')} = ${range(diff, w + 1, w - 1, 0)};`);
        if (isWired(comp, 'bout')) body.push(`  assign ${out('bout')} = ${diff}[${w}];`);
        break;
      }
      case 'multiplier': {
        const w = bits;
        if (!isWired(comp, 'p') && !isWired(comp, 'hi')) break;
        const prod = identifier(`prod${comp.id}`, taken);
        decls.push(`  wire [${2 * w - 1}:0] ${prod};`);
        const add = isWired(comp, 'cin') ? ` + ${nameOf(comp, 'cin')}` : '';
        body.push(`  assign ${prod} = ${operand(comp, 'a', unknownBits(w))} * ${operand(comp, 'b', unknownBits(w))}${add};`);
        if (isWired(comp, 'p')) body.push(`  assign ${out('p')} = ${range(prod, 2 * w, w - 1, 0)};`);
        if (isWired(comp, 'hi')) body.push(`  assign ${out('hi')} = ${range(prod, 2 * w, 2 * w - 1, w)};`);
        break;
      }
      case 'divider': {
        if (isWired(comp, 'hi')) throw new ExportError(`The divider in circuit '${c.name}' has a connected Hi input, which cannot be exported.`);
        const a = operand(comp, 'a', unknownBits(bits));
        const b = operand(comp, 'b', unknownBits(bits));
        if (isWired(comp, 'q')) body.push(`  assign ${out('q')} = ${a} / ${b};`);
        if (isWired(comp, 'r')) body.push(`  assign ${out('r')} = ${a} % ${b};`);
        break;
      }
      case 'negator': {
        if (isWired(comp, 'y')) body.push(`  assign ${out('y')} = -${operand(comp, 'a', unknownBits(bits))};`);
        break;
      }
      case 'comparator': {
        const a = operand(comp, 'a', unknownBits(bits));
        const b = operand(comp, 'b', unknownBits(bits));
        const [x, y] = props.numeric === 'signed' ? [`$signed(${a})`, `$signed(${b})`] : [a, b];
        if (isWired(comp, 'gt')) body.push(`  assign ${out('gt')} = ${x} > ${y};`);
        if (isWired(comp, 'eq')) body.push(`  assign ${out('eq')} = ${x} == ${y};`);
        if (isWired(comp, 'lt')) body.push(`  assign ${out('lt')} = ${x} < ${y};`);
        break;
      }
      case 'shifter': {
        if (props.mode === 'rol' || props.mode === 'ror') throw new ExportError(`The shifter in circuit '${c.name}' rotates, which cannot be exported.`);
        if (!isWired(comp, 'y')) break;
        // z is read as x (a library part does that); Icarus would pass a floating operand through a shift.
        const a = `(${operand(comp, 'a', unknownBits(bits))} ^ ${bits}'d0)`;
        const n = operand(comp, 'n', unknownBits(1));
        const expr = props.mode === 'srl' ? `${a} >> ${n}` : props.mode === 'sra' ? `$signed(${a}) >>> ${n}` : `${a} << ${n}`;
        body.push(`  assign ${out('y')} = ${expr};`);
        break;
      }
      case 'rom': {
        if (!isWired(comp, 'd')) break;
        const aw = Number(props.addrBits ?? 4);
        const dw = Number(props.dataBits ?? 8);
        const words = String(props.contents ?? '').split(/\s+/).filter(Boolean).map((t) => parseInt(t, 16) & (dw >= 32 ? 0xffffffff : (1 << dw) - 1));
        const rom = identifier(`rom${comp.id}`, taken);
        const i = identifier(`i${comp.id}`, taken);
        decls.push(`  reg ${decl(dw)}${rom} [0:${2 ** aw - 1}];`, `  integer ${i};`);
        const sets = words.slice(0, 2 ** aw).flatMap((v, k) => (v === 0 ? [] : [`    ${rom}[${k}] = ${dw}'h${(v >>> 0).toString(16).toUpperCase()};`]));
        body.push(`  initial begin`, `    for (${i} = 0; ${i} < ${2 ** aw}; ${i} = ${i} + 1) ${rom}[${i}] = ${dw}'d0;`, ...sets, `  end`);
        const read = `${rom}[${operand(comp, 'a', unknownBits(aw))}]`;
        body.push(`  assign ${out('d')} = ${isWired(comp, 'oe') ? `${nameOf(comp, 'oe')} === 1'b0 ? ${dw}'bz : ` : ''}${read};`);
        break;
      }
      case 'ram': {
        if (props.bus === 'single' || props.asyncRead === false) throw new ExportError(`The RAM in circuit '${c.name}' uses a shared data bus or a clocked read, which cannot be exported.`);
        if (isWired(comp, 'clr') || isWired(comp, 'oe')) throw new ExportError(`The RAM in circuit '${c.name}' has a connected CLR or OE, which cannot be exported.`);
        if (!isWired(comp, 'clk')) throw new ExportError(`A RAM in circuit '${c.name}' has no clock connected.`);
        const aw = Number(props.addrBits ?? 8);
        const dw = Number(props.dataBits ?? 8);
        const mem = identifier(`ram${comp.id}`, taken);
        const i = identifier(`i${comp.id}`, taken);
        decls.push(`  reg ${decl(dw)}${mem} [0:${2 ** aw - 1}];`, `  integer ${i};`);
        body.push(`  initial for (${i} = 0; ${i} < ${2 ** aw}; ${i} = ${i} + 1) ${mem}[${i}] = ${dw}'d0;`);
        const edge = props.trigger === 'falling' ? 'negedge' : 'posedge';
        const addr = operand(comp, 'a', unknownBits(aw));
        body.push(always(edge, nameOf(comp, 'clk'), `if (${operand(comp, 'we', "1'b0")} === 1'b1) ${mem}[${addr}] <= ${operand(comp, 'din', unknownBits(dw))};`));
        if (isWired(comp, 'dout')) body.push(`  assign ${out('dout')} = ${mem}[${addr}];`);
        break;
      }
      default: {
        if (!comp.type.startsWith('sub:')) throw new ExportError(`Part ${comp.type} cannot be exported.`);
        const callee = project.circuits.find((x) => `sub:${x.id}` === comp.type)!;
        const portMap = portIdents.get(callee.id)!;
        const conns = pinsOfComp
          .get(comp.id)!
          .filter((p) => isWired(comp, p.name))
          .map((p) => `.${portMap.get(p.name)}(${p.dir === 'out' ? out(p.name) : nameOf(comp, p.name)})`);
        const inst = identifier(`u_${comp.id}`, taken);
        body.push(`  ${moduleNames.get(callee.id)} ${inst} (${conns.join(', ')});`);
      }
    }
  }
  if (usesLive) decls.push(`  reg ${live} = 1'b0;`, `  initial #1 ${live} = 1'b1;`);
  return [`module ${mod} (${header.join(', ')});`, ...decls, ...body, 'endmodule'].join('\n');
}

const SUPPORTED = new Set(['pin', 'const', 'not', 'and', 'or', 'nand', 'nor', 'xor', 'xnor', 'adder', 'subtractor', 'multiplier', 'divider', 'negator', 'comparator', 'shifter', 'mux', 'splitter', 'extender', 'register', 'junction', 'pull', 'tribuf', 'dff', 'dlatch', 'rom', 'ram']);

/** ` = N'b0101` for a part with a power-on value (bits over 0 1 x, as the `init` property is read), nothing for one that starts at x. */
function initOf(init: unknown, width: number): string {
  const text = powerOnProp(String(init ?? ''));
  if (text === undefined) return '';
  return ` = ${width}'b${text.toLowerCase().replace(/[^01x]/g, '').slice(-width).padStart(width, '0')}`;
}

export function exportVerilog(project: Project): string {
  useProject(project);
  const moduleNames = new Map<string, string>();
  const taken = new Set<string>();
  for (const c of project.circuits) moduleNames.set(c.id, identifier(c.name, taken));
  const portIdents = new Map<string, Map<string, string>>();
  for (const c of project.circuits) {
    const used = new Set<string>();
    const map = new Map<string, string>();
    for (const [, name] of portNames(c)) map.set(name, identifier(name, used));
    portIdents.set(c.id, map);
  }
  const order: Circuit[] = [];
  const seen = new Set<string>();
  const visit = (c: Circuit) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    for (const comp of Object.values(c.components).sort(byNumber)) {
      if (!comp.type.startsWith('sub:')) continue;
      const callee = project.circuits.find((x) => `sub:${x.id}` === comp.type);
      if (callee) visit(callee);
    }
    order.push(c);
  };
  project.circuits.forEach(visit);
  const text = order.map((c) => exportCircuit(c, project, moduleNames, portIdents));
  return [`// Structural Verilog exported from the iHateCircuits project "${project.name}". Top module: ${moduleNames.get(project.main)}.`, ...text, ''].join('\n\n');
}
