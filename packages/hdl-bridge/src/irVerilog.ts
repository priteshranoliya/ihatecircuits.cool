import { KEYWORDS } from '@ihatecircuits/hdl';
import type { Cell, Design, Module, Net, NetId } from '@ihatecircuits/hdl/design';

/**
 * Behavioural Verilog for an IR Design: one module per module, one statement per cell, written to
 * be read against design.ts. It is not a synthesis result. Its job is to let a reference Verilog
 * simulator (Icarus) evaluate the IR so that the IR interpreter and every back end can be checked
 * against something that is not our own code.
 *
 * Every net is declared as a vector, even at one bit, so that bit and part selects always work.
 * Ports are plain `input`/`output` vectors; a net with a resolution kind other than `wire` is an
 * internal net that the port is assigned from or to.
 *
 * Where Verilog and the IR differ, the text is written to follow the IR.
 *   - A cell reads z as x, except a slice and a concatenation, which are wiring and pass z through as a
 *     Verilog expression does. Operators already read z as x. Where a Verilog expression would pass z
 *     through into a cell that must not (a register's data, a mux arm) the value is XORed with zero
 *     (`^ 4'd0`), which turns z into x and leaves 0 and 1 alone. The same wrapper goes inside `~`, because Icarus
 *     answers z for the complement of an all-z vector.
 *   - A tri-state buffer is written out per bit: the data while enabled, z while disabled, and
 *     with an unknown enable x where the data is not z.
 *   - An asynchronously reset register keeps its state in a plain register and reads
 *     `arst == level ? value : state` on the way out, so a reset that is active from time 0 shows
 *     at once and an unknown reset merges the two, as the IR says.
 *   - A latch is a procedural block that follows `d` while enabled and holds otherwise; with an
 *     unknown enable `en ? d : state` gives the bitwise merge the interpreter uses.
 *   - Signed division, remainder, shift and comparison go through `$signed`.
 *   - A Verilog simulator counts the clock going from x to 0 at power-on as a falling edge (and x to 1
 *     as a rising one); the IR ignores a clock until it has had a known level. Every edge-triggered
 *     block is therefore gated by `live`, a reg that becomes 1 at time 1, which is after the
 *     testbench's declaration initialisers have run and before its first clock edge.
 */

export class IrVerilogError extends Error {}

const PREFIX = 'x_';

function ident(raw: string, taken: Set<string>): string {
  let s = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = `n_${s}`;
  if (KEYWORDS.has(s)) s = `${s}_`;
  let name = s;
  for (let i = 2; taken.has(name); i++) name = `${s}_${i}`;
  taken.add(name);
  return name;
}

const vec = (w: number) => `[${w - 1}:0] `;
const lit = (bits: string) => `${bits.length}'b${bits}`;
const zeroOf = (w: number) => `${w}'d0`;
/** A register's declaration initialiser (` = 4'b1x01`), or nothing when it starts unknown. */
const startsAt = (init: string | undefined, w: number) => (init !== undefined && /[01]/.test(init) ? ` = ${lit(init.slice(-w).padStart(w, '0'))}` : '');

const NET_KEYWORD: Record<NonNullable<Net['kind']>, string> = {
  wire: 'wire',
  wand: 'wand',
  wor: 'wor',
  pull0: 'tri0',
  pull1: 'tri1',
  supply0: 'supply0',
  supply1: 'supply1',
};

function printModule(m: Module, moduleNames: Map<string, string>, portNames: Map<string, Map<string, string>>): string {
  const taken = new Set<string>(m.ports.map((p) => p.name));
  const width = (n: NetId) => m.nets[n]!.width;

  // A net is named after the first port bound to it when it is a plain wire, otherwise after its first source name.
  const name = new Map<NetId, string>();
  const portNet = new Set<NetId>();
  const ports = portNames.get(m.name)!;
  for (const p of m.ports) {
    const net = m.nets[p.net]!;
    if ((net.kind ?? 'wire') === 'wire' && !name.has(p.net)) {
      name.set(p.net, ports.get(p.name)!);
      portNet.add(p.net);
    }
  }
  for (const net of m.nets) if (!name.has(net.id)) name.set(net.id, ident(net.names[0] ?? `${PREFIX}${net.id}`, taken));
  const n = (id: NetId) => name.get(id)!;
  /** An operand as a plain vector name. */
  const rd = (id: NetId) => n(id);
  /** An operand with z turned into x. */
  const rx = (id: NetId) => `(${n(id)} ^ ${zeroOf(width(id))})`;

  const header: string[] = [];
  const decls: string[] = [];
  const body: string[] = [];

  for (const p of m.ports) header.push(`${p.dir === 'in' ? 'input' : 'output'} ${vec(p.width)}${ports.get(p.name)!}`);
  for (const net of m.nets) {
    if (portNet.has(net.id)) continue;
    decls.push(`  ${NET_KEYWORD[net.kind ?? 'wire']} ${vec(net.width)}${n(net.id)};`);
  }
  for (const p of m.ports) {
    const port = ports.get(p.name)!;
    if (n(p.net) === port) continue;
    body.push(p.dir === 'in' ? `  assign ${n(p.net)} = ${port};` : `  assign ${port} = ${n(p.net)};`);
  }

  const assign = (out: NetId, expr: string) => body.push(`  assign ${n(out)} = ${expr};`);
  const signed = (id: NetId) => `$signed(${rd(id)})`;
  let seq = 0;
  const uid = (stem: string) => ident(`${stem}_${seq++}`, taken);

  const clocked = (clk: NetId, edge: 'pos' | 'neg') => `${edge === 'pos' ? 'posedge' : 'negedge'} ${rd(clk)}`;
  const live = ident('live', taken);
  let usesLive = false;
  const gated = (stmt: string) => {
    usesLive = true;
    return `if (${live}) ${stmt}`;
  };
  const gatedTerm = (cond: string) => {
    usesLive = true;
    return `(${cond}) && ${live}`;
  };

  m.cells.forEach((c: Cell) => {
    switch (c.kind) {
      case 'const':
        assign(c.out, lit(c.bits));
        break;
      case 'not':
        assign(c.out, `~${rx(c.a)}`);
        break;
      case 'and':
        assign(c.out, `${rd(c.a)} & ${rd(c.b)}`);
        break;
      case 'or':
        assign(c.out, `${rd(c.a)} | ${rd(c.b)}`);
        break;
      case 'xor':
        assign(c.out, `${rd(c.a)} ^ ${rd(c.b)}`);
        break;
      case 'xnor':
        assign(c.out, `~(${rd(c.a)} ^ ${rd(c.b)})`);
        break;
      case 'add':
        assign(c.out, `${rd(c.a)} + ${rd(c.b)}`);
        break;
      case 'sub':
        assign(c.out, `${rd(c.a)} - ${rd(c.b)}`);
        break;
      case 'mul':
        assign(c.out, `${rd(c.a)} * ${rd(c.b)}`);
        break;
      case 'divu':
        assign(c.out, `${rd(c.a)} / ${rd(c.b)}`);
        break;
      case 'remu':
        assign(c.out, `${rd(c.a)} % ${rd(c.b)}`);
        break;
      case 'divs':
        assign(c.out, `${signed(c.a)} / ${signed(c.b)}`);
        break;
      case 'rems':
        assign(c.out, `${signed(c.a)} % ${signed(c.b)}`);
        break;
      case 'shl':
        assign(c.out, `${rx(c.a)} << ${rd(c.amount)}`);
        break;
      case 'shr':
        assign(c.out, `${rx(c.a)} >> ${rd(c.amount)}`);
        break;
      case 'sshr':
        assign(c.out, `$signed(${rx(c.a)}) >>> ${rd(c.amount)}`);
        break;
      case 'eq':
        assign(c.out, `${rd(c.a)} == ${rd(c.b)}`);
        break;
      case 'ne':
        assign(c.out, `${rd(c.a)} != ${rd(c.b)}`);
        break;
      case 'ltu':
        assign(c.out, `${rd(c.a)} < ${rd(c.b)}`);
        break;
      case 'lts':
        assign(c.out, `${signed(c.a)} < ${signed(c.b)}`);
        break;
      case 'reduce_and':
        assign(c.out, `&${rd(c.a)}`);
        break;
      case 'reduce_or':
        assign(c.out, `|${rd(c.a)}`);
        break;
      case 'reduce_xor':
        assign(c.out, `^${rd(c.a)}`);
        break;
      case 'mux':
        assign(c.out, `${rd(c.sel)} ? ${rx(c.onTrue)} : ${rx(c.onFalse)}`);
        break;
      case 'concat':
        assign(c.out, `{${c.parts.map(rd).join(', ')}}`);
        break;
      case 'slice': {
        const hi = c.lsb + width(c.out) - 1;
        assign(c.out, `${rd(c.a)}[${hi}:${c.lsb}]`);
        break;
      }
      case 'tribuf': {
        for (let i = 0; i < width(c.out); i++) {
          const a = `${rd(c.a)}[${i}]`;
          body.push(`  assign ${n(c.out)}[${i}] = ${rd(c.en)} === 1'b1 ? (${a} ^ 1'b0) : ${rd(c.en)} === 1'b0 ? 1'bz : (${a} === 1'bz ? 1'bz : 1'bx);`);
        }
        break;
      }
      case 'dff': {
        const q = uid('q');
        decls.push(`  reg ${vec(width(c.q))}${q}${startsAt(c.init, width(c.q))};`);
        body.push(`  always @(${clocked(c.clk, c.edge)}) ${gated(`${q} <= ${rx(c.d)};`)}`);
        assign(c.q, q);
        break;
      }
      case 'adff': {
        const q = uid('q');
        const active = `1'b${c.arstLevel}`;
        decls.push(`  reg ${vec(width(c.q))}${q}${startsAt(c.init, width(c.q))};`);
        body.push(`  always @(${clocked(c.clk, c.edge)}) ${gated(`${q} <= ${rd(c.arst)} == ${active} ? ${lit(c.arstValue)} : ${rx(c.d)};`)}`);
        assign(c.q, `${rd(c.arst)} == ${active} ? ${lit(c.arstValue)} : ${q}`);
        break;
      }
      case 'latch': {
        const q = uid('q');
        const on = `1'b${c.enLevel}`;
        const off = `1'b${1 - c.enLevel}`;
        decls.push(`  reg ${vec(width(c.q))}${q}${startsAt(c.init, width(c.q))};`);
        // A latch that holds a power-on value must not merge it away while the nets are still settling and its enable reads x:
        // the merge waits until time 1. A known enable acts at once, so a latch that is open at power-on follows `d` from time 0.
        const hold = c.init !== undefined && /[01]/.test(c.init) ? gatedTerm(`${rd(c.en)} !== ${off}`) : `${rd(c.en)} !== ${off}`;
        body.push(`  always @* if (${rd(c.en)} === ${on}) ${q} = ${rx(c.d)}; else if (${hold}) ${q} = ${rd(c.en)} ? ${rx(c.d)} : ${q};`);
        assign(c.q, q);
        break;
      }
      case 'memory': {
        const mem = uid(`mem_${c.name}`);
        decls.push(`  reg ${vec(c.width)}${mem} [0:${c.depth - 1}];`);
        if (c.init) {
          const words = c.init.slice(0, c.depth).map((w, a) => `    ${mem}[${a}] = ${lit(w.slice(-c.width).padStart(c.width, '0'))};`);
          if (words.length) body.push('  initial begin', ...words, '  end');
        }
        c.readPorts.forEach((p) => {
          if (p.clk === undefined) {
            const r = uid('rd');
            decls.push(`  reg ${vec(c.width)}${r};`);
            body.push(`  always @* ${r} = ${mem}[${rd(p.addr)}];`);
            assign(p.data, r);
          } else {
            const r = uid('rd');
            decls.push(`  reg ${vec(c.width)}${r};`);
            body.push(`  always @(${clocked(p.clk, p.edge ?? 'pos')}) ${gated(`${r} <= ${mem}[${rd(p.addr)}];`)}`);
            assign(p.data, r);
          }
        });
        const groups = new Map<string, typeof c.writePorts>();
        for (const p of c.writePorts) {
          const key = clocked(p.clk, p.edge);
          groups.set(key, [...(groups.get(key) ?? []), p]);
        }
        for (const [key, ports] of groups) {
          body.push(`  always @(${key}) begin`);
          for (const p of ports) body.push(`    ${gated(`if (${rd(p.en)} === 1'b1) ${mem}[${rd(p.addr)}] <= ${rx(p.data)};`)}`);
          body.push('  end');
        }
        break;
      }
      case 'instance': {
        const callee = portNames.get(c.module);
        if (!callee) throw new IrVerilogError(`instance ${c.name} of unknown module ${c.module}`);
        const conns = [...Object.entries(c.inputs), ...Object.entries(c.outputs)].map(([port, net]) => `.${callee.get(port) ?? port}(${n(net)})`);
        body.push(`  ${moduleNames.get(c.module)!} ${uid(c.name)} (${conns.join(', ')});`);
        break;
      }
    }
  });
  if (usesLive) decls.push(`  reg ${live} = 1'b0;`, `  initial #1 ${live} = 1'b1;`);
  return [`module ${moduleNames.get(m.name)!} (${header.join(', ')});`, ...decls, ...body, 'endmodule'].join('\n');
}

/**
 * Verilog text for a Design, callees first, with `design.top` named in a leading comment.
 * The top module keeps its name and its port names.
 */
export function designToVerilog(design: Design): string {
  const moduleNames = new Map<string, string>();
  const takenModules = new Set<string>();
  for (const m of design.modules) moduleNames.set(m.name, m.name === design.top ? ident(m.name, takenModules) : ident(m.name, takenModules));
  const portNames = new Map<string, Map<string, string>>();
  for (const m of design.modules) {
    const used = new Set<string>();
    const names = new Map(m.ports.map((p) => [p.name, ident(p.name, used)]));
    if (m.name === design.top) {
      const bad = m.ports.find((p) => names.get(p.name) !== p.name);
      if (bad) throw new IrVerilogError(`The port '${bad.name}' of the top module is not a Verilog identifier or is a keyword, so the printed text could not keep its name.`);
    }
    portNames.set(m.name, names);
  }
  const text = design.modules.map((m) => printModule(m, moduleNames, portNames));
  return [`// IR rendered as behavioural Verilog. Top module: ${moduleNames.get(design.top)!}.`, ...text, ''].join('\n\n');
}

