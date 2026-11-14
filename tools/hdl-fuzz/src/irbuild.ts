import type { Cell, Design, Module, Net, NetId, Port } from '@ihatecircuits/hdl/design';

/** Builds one IR module cell by cell. Used by the IR generator and by tests that need a hand-made design. */
export class ModuleBuilder {
  readonly nets: Net[] = [];
  readonly cells: Cell[] = [];
  readonly ports: Port[] = [];

  constructor(readonly name: string) {}

  net(width: number, opts: { name?: string; kind?: Net['kind'] } = {}): NetId {
    const id = this.nets.length;
    this.nets.push({ id, width, names: opts.name ? [opts.name] : [], ...(opts.kind ? { kind: opts.kind } : {}) });
    return id;
  }

  input(name: string, width: number): NetId {
    const net = this.net(width, { name });
    this.ports.push({ name, dir: 'in', width, net });
    return net;
  }

  output(name: string, net: NetId): void {
    this.ports.push({ name, dir: 'out', width: this.nets[net]!.width, net });
  }

  width(net: NetId): number {
    return this.nets[net]!.width;
  }

  add(cell: Cell): Cell {
    this.cells.push(cell);
    return cell;
  }

  build(): Module {
    return { name: this.name, ports: this.ports, nets: this.nets, cells: this.cells };
  }
}

export const designOf = (...modules: Module[]): Design => ({ modules, top: modules[modules.length - 1]!.name });
