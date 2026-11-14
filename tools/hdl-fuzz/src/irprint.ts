import { cellInputs, cellOutputs, type Cell, type Design, type Module, type NetId } from '@ihatecircuits/hdl/design';

/** A compact text form of a design, for reading a failing case. `cone` limits a module to what feeds the given output ports. */
export function printDesign(design: Design, cone?: string[]): string {
  return design.modules.map((m) => printModule(m, m.name === design.top ? cone : undefined)).join('\n\n');
}

function printModule(m: Module, cone?: string[]): string {
  const name = (n: NetId) => `n${n}[${m.nets[n]!.width}${m.nets[n]!.kind && m.nets[n]!.kind !== 'wire' ? ' ' + m.nets[n]!.kind : ''}]`;
  const keep = new Set<number>();
  if (cone) {
    const want = new Set<NetId>(m.ports.filter((p) => p.dir === 'out' && cone.includes(p.name)).map((p) => p.net));
    for (let again = true; again; ) {
      again = false;
      m.cells.forEach((c, i) => {
        if (keep.has(i) || !cellOutputs(c).some((o) => want.has(o))) return;
        keep.add(i);
        for (const n of cellInputs(c)) want.add(n);
        again = true;
      });
    }
  }
  const lines = [`module ${m.name}(${m.ports.map((p) => `${p.dir} ${p.name}=${name(p.net)}`).join(', ')})`];
  m.cells.forEach((c, i) => {
    if (cone && !keep.has(i)) return;
    lines.push(`  ${describe(c, name)}`);
  });
  return lines.join('\n');
}

function describe(c: Cell, name: (n: NetId) => string): string {
  const { kind, ...rest } = c as Cell & Record<string, unknown>;
  const fields = Object.entries(rest).map(([k, v]) => {
    if (typeof v === 'number' && ['a', 'b', 'out', 'sel', 'onTrue', 'onFalse', 'amount', 'clk', 'd', 'q', 'en', 'arst'].includes(k)) return `${k}=${name(v)}`;
    if (k === 'parts') return `parts=[${(v as number[]).map(name).join(' ')}]`;
    if (k === 'readPorts' || k === 'writePorts') return `${k}=${JSON.stringify(v)}`;
    return `${k}=${JSON.stringify(v)}`;
  });
  return `${kind} ${fields.join(' ')}`;
}
