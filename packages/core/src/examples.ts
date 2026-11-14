import { addComponent, connect, emptyCircuit } from './edit';
import { subType, useProject } from './project';
import type { Circuit, Project, Rotation } from './types';

/** Fluent builder for the bundled examples. */
class CB {
  c: Circuit;
  constructor(id: string, name: string) {
    this.c = emptyCircuit(name, id);
  }
  add(type: string, x: number, y: number, label = '', props: Record<string, unknown> = {}, rot: Rotation = 0): string {
    const r = addComponent(this.c, { type, x, y, label, props, rot });
    this.c = r.circuit;
    return r.id;
  }
  wire(a: string, ap: string, b: string, bp: string, mid?: number): this {
    const r = connect(this.c, { comp: a, pin: ap }, { comp: b, pin: bp });
    if ('error' in r) throw new Error(`Example wiring failed: ${a}.${ap} → ${b}.${bp} (${r.error})`);
    this.c = r.circuit;
    if (mid !== undefined) this.c = { ...this.c, wires: { ...this.c.wires, [r.id]: { ...this.c.wires[r.id], mid } } };
    return this;
  }
  note(x: number, y: number, text: string): this {
    this.add('text', x, y, '', { text });
    return this;
  }
}

const single = (name: string, build: (b: CB) => void): Project => {
  const b = new CB('main', name);
  build(b);
  return { name, main: 'main', circuits: [b.c] };
};

export interface Example {
  id: string;
  title: string;
  topic: 'Basics' | 'Arithmetic' | 'Buses and electrical' | 'Sequential' | 'Hierarchy';
  summary: string;
  build: () => Project;
}

/** A half adder with Pin ports, reused by the hierarchy examples. */
function halfAdderCircuit(id: string): Circuit {
  const b = new CB(id, 'Half adder');
  const A = b.add('pin', 60, 40, 'A');
  const B = b.add('pin', 60, 120, 'B');
  const x = b.add('xor', 160, 30);
  const a = b.add('and', 160, 110);
  const S = b.add('pin', 300, 40, 'S', { io: 'out' });
  const C = b.add('pin', 300, 120, 'C', { io: 'out' });
  b.wire(A, 'p', x, 'in0', 120).wire(A, 'p', a, 'in0', 120).wire(B, 'p', x, 'in1', 140).wire(B, 'p', a, 'in1', 140);
  b.wire(x, 'out', S, 'p').wire(a, 'out', C, 'p');
  return b.c;
}

/** Make subcircuits resolvable while an example wires to their pins. */
const using = (...circuits: Circuit[]) => useProject({ name: 'building', main: circuits[0].id, circuits });

/** Full adder from two half-adder instances and an OR gate. */
function fullAdderCircuit(id: string, haCircuit: Circuit): Circuit {
  using(haCircuit);
  const ha = haCircuit.id;
  const b = new CB(id, 'Full adder');
  const A = b.add('pin', 40, 40, 'A');
  const B = b.add('pin', 40, 80, 'B');
  const Ci = b.add('pin', 40, 160, 'Cin');
  const h1 = b.add(subType(ha), 140, 20);
  const h2 = b.add(subType(ha), 280, 60);
  const o = b.add('or', 440, 120);
  const S = b.add('pin', 560, 80, 'S', { io: 'out' });
  const Co = b.add('pin', 560, 140, 'Cout', { io: 'out' });
  b.wire(A, 'p', h1, 'A').wire(B, 'p', h1, 'B').wire(h1, 'S', h2, 'A').wire(Ci, 'p', h2, 'B', 250);
  b.wire(h2, 'S', S, 'p').wire(h1, 'C', o, 'in0', 400).wire(h2, 'C', o, 'in1').wire(o, 'out', Co, 'p');
  return b.c;
}

export const EXAMPLES: Example[] = [
  {
    id: 'gates',
    title: 'Basic gates',
    topic: 'Basics',
    summary: 'Two switches drive AND, OR, XOR, NAND and NOT side by side. Flip A and B to compare.',
    build: () =>
      single('Basic gates', (b) => {
        const A = b.add('switch', 40, 60, 'A');
        const B = b.add('switch', 40, 180, 'B');
        for (const [type, label, y] of [
          ['and', 'AND', 20],
          ['or', 'OR', 90],
          ['xor', 'XOR', 160],
          ['nand', 'NAND', 230],
        ] as const) {
          const g = b.add(type, 180, y);
          const led = b.add('led', 300, y + 10, label);
          b.wire(A, 'out', g, 'in0', 120).wire(B, 'out', g, 'in1', 140).wire(g, 'out', led, 'in');
        }
        const n = b.add('not', 180, 300);
        const ln = b.add('led', 300, 300, 'NOT A');
        b.wire(A, 'out', n, 'in0', 120).wire(n, 'out', ln, 'in');
      }),
  },
  {
    id: 'half-adder',
    title: 'Half adder',
    topic: 'Arithmetic',
    summary: 'S = A ⊕ B and C = A·B: the smallest circuit that adds two bits.',
    build: () =>
      single('Half adder', (b) => {
        const A = b.add('switch', 40, 40, 'A');
        const B = b.add('switch', 40, 120, 'B');
        const x = b.add('xor', 160, 30);
        const a = b.add('and', 160, 110);
        const S = b.add('led', 280, 40, 'S');
        const C = b.add('led', 280, 120, 'C', { color: 'red' });
        b.wire(A, 'out', x, 'in0', 110).wire(A, 'out', a, 'in0', 110).wire(B, 'out', x, 'in1', 130).wire(B, 'out', a, 'in1', 130);
        b.wire(x, 'out', S, 'in').wire(a, 'out', C, 'in');
      }),
  },
  {
    id: 'full-adder',
    title: 'Full adder',
    topic: 'Arithmetic',
    summary: 'Adds A, B and a carry-in with two XORs, two ANDs and an OR.',
    build: () =>
      single('Full adder', (b) => {
        const A = b.add('switch', 40, 40, 'A');
        const B = b.add('switch', 40, 100, 'B');
        const Ci = b.add('switch', 40, 200, 'Cin');
        const x1 = b.add('xor', 160, 40);
        const a1 = b.add('and', 160, 120);
        const x2 = b.add('xor', 300, 50);
        const a2 = b.add('and', 300, 170);
        const o = b.add('or', 420, 130);
        const S = b.add('led', 540, 60, 'S');
        const Co = b.add('led', 540, 140, 'Cout', { color: 'red' });
        b.wire(A, 'out', x1, 'in0', 110).wire(A, 'out', a1, 'in0', 110).wire(B, 'out', x1, 'in1', 130).wire(B, 'out', a1, 'in1', 130);
        b.wire(x1, 'out', x2, 'in0', 250).wire(x1, 'out', a2, 'in0', 250).wire(Ci, 'out', x2, 'in1', 270).wire(Ci, 'out', a2, 'in1', 270);
        b.wire(a1, 'out', o, 'in0').wire(a2, 'out', o, 'in1', 390).wire(x2, 'out', S, 'in').wire(o, 'out', Co, 'in');
      }),
  },
  {
    id: 'majority',
    title: 'Majority voter',
    topic: 'Basics',
    summary: 'M is 1 when at least two of three inputs are 1. Open Analyze to see its K-map and M = AB + AC + BC.',
    build: () =>
      single('Majority voter', (b) => {
        const A = b.add('switch', 40, 40, 'A');
        const B = b.add('switch', 40, 120, 'B');
        const C = b.add('switch', 40, 200, 'C');
        const g1 = b.add('and', 200, 20);
        const g2 = b.add('and', 200, 100);
        const g3 = b.add('and', 200, 180);
        const o = b.add('or', 320, 90, '', { inputs: 3 });
        const M = b.add('led', 440, 110, 'M', { color: 'green' });
        b.wire(A, 'out', g1, 'in0', 120).wire(B, 'out', g1, 'in1', 140);
        b.wire(B, 'out', g2, 'in0', 140).wire(C, 'out', g2, 'in1', 160);
        b.wire(A, 'out', g3, 'in0', 120).wire(C, 'out', g3, 'in1');
        b.wire(g1, 'out', o, 'in0', 290).wire(g2, 'out', o, 'in1').wire(g3, 'out', o, 'in2', 290).wire(o, 'out', M, 'in');
      }),
  },
  {
    id: 'mux-gates',
    title: '2:1 multiplexer from gates',
    topic: 'Basics',
    summary: 'Y = D0·S′ + D1·S. The select line S picks which data input reaches the output.',
    build: () =>
      single('2:1 multiplexer', (b) => {
        const D0 = b.add('switch', 40, 40, 'D0');
        const D1 = b.add('switch', 40, 120, 'D1');
        const S = b.add('switch', 40, 220, 'S');
        const n = b.add('not', 120, 220);
        const a1 = b.add('and', 240, 40);
        const a2 = b.add('and', 240, 120);
        const o = b.add('or', 360, 80);
        const Y = b.add('led', 480, 90, 'Y');
        b.wire(D0, 'out', a1, 'in0').wire(D1, 'out', a2, 'in0').wire(S, 'out', n, 'in0').wire(n, 'out', a1, 'in1', 200);
        b.wire(S, 'out', a2, 'in1', 100).wire(a1, 'out', o, 'in0', 330).wire(a2, 'out', o, 'in1', 330).wire(o, 'out', Y, 'in');
      }),
  },
  {
    id: 'decoder',
    title: '2-to-4 decoder',
    topic: 'Basics',
    summary: 'A 2-bit DIP switch feeds the decoder’s select bus. Exactly one LED lights: the one numbered by the switches.',
    build: () =>
      single('2-to-4 decoder', (b) => {
        const sw = b.add('dip', 60, 80, 'A', { count: 2 });
        const d = b.add('decoder', 180, 40, '', { sel: 2 });
        b.wire(sw, 'out', d, 's');
        for (let i = 0; i < 4; i++) {
          const led = b.add('led', 340, 60 + 20 * i, `Y${i}`, { color: 'green' });
          b.wire(d, `y${i}`, led, 'in');
        }
      }),
  },
  {
    id: 'adder4',
    title: '4-bit adder on buses',
    topic: 'Arithmetic',
    summary: 'Two 4-bit DIP switches feed an adder over buses; the hex display shows the sum and Cout lights past F.',
    build: () =>
      single('4-bit adder', (b) => {
        const A = b.add('dip', 40, 40, 'A', { count: 4 });
        const B = b.add('dip', 40, 100, 'B', { count: 4 });
        const add = b.add('adder', 200, 40, '', { bits: 4 });
        const sum = b.add('hex', 380, 20, 'Sum', { input: 'bus' });
        const co = b.add('led', 380, 150, 'Cout', { color: 'red' });
        const probe = b.add('probe', 380, 200, 'Decimal', { radix: 'dec' });
        b.wire(A, 'out', add, 'a').wire(B, 'out', add, 'b', 160).wire(add, 's', sum, 'd', 330).wire(add, 'cout', co, 'in', 340).wire(add, 's', probe, 'p', 330);
      }),
  },
  {
    id: 'tristate-bus',
    title: 'Shared bus with tri-state buffers',
    topic: 'Buses and electrical',
    summary: 'Two 4-bit sources share one bus. Enable one at a time to see its value; enable both with different values and the bus shows a conflict.',
    build: () =>
      single('Tri-state bus', (b) => {
        const s0 = b.add('dip', 40, 40, 'Source 0', { count: 4, value: 5 });
        const s1 = b.add('dip', 40, 160, 'Source 1', { count: 4, value: 10 });
        const e0 = b.add('switch', 120, 100, 'EN0');
        const e1 = b.add('switch', 120, 220, 'EN1');
        const b0 = b.add('tribuf', 220, 40, '', { bits: 4 });
        const b1 = b.add('tribuf', 220, 160, '', { bits: 4 });
        const bus = b.add('probe', 380, 100, 'Bus', { radix: 'hex' });
        b.wire(s0, 'out', b0, 'in0').wire(s1, 'out', b1, 'in0').wire(e0, 'out', b0, 'en').wire(e1, 'out', b1, 'en');
        b.wire(b0, 'out', bus, 'p', 320).wire(b1, 'out', bus, 'p', 320);
        b.note(40, 280, 'Nothing enabled: the bus floats (Z). Two enabled drivers that disagree: conflict.');
      }),
  },
  {
    id: 'wired-and',
    title: 'Open-drain wired-AND',
    topic: 'Buses and electrical',
    summary: 'Open-drain outputs can only pull a line low; a pull-up resistor holds it high otherwise. The line is 1 only when every output lets go.',
    build: () =>
      single('Wired-AND', (b) => {
        const A = b.add('switch', 40, 60, 'A');
        const B = b.add('switch', 40, 140, 'B');
        const ga = b.add('buffer', 120, 60, '', { output: '0z' });
        const gb = b.add('buffer', 120, 140, '', { output: '0z' });
        const pu = b.add('pull', 250, 20);
        const L = b.add('led', 320, 100, 'Line');
        b.wire(A, 'out', ga, 'in0').wire(B, 'out', gb, 'in0').wire(ga, 'out', L, 'in', 260).wire(gb, 'out', L, 'in', 260).wire(pu, 'p', L, 'in');
      }),
  },
  {
    id: 'cmos-nand',
    title: 'CMOS NAND from transistors',
    topic: 'Buses and electrical',
    summary: 'Two P-type transistors in parallel pull the output up; two N-types in series pull it down. For every input exactly one network conducts.',
    build: () =>
      single('CMOS NAND', (b) => {
        const A = b.add('switch', 40, 120, 'A');
        const B = b.add('switch', 40, 220, 'B');
        const vdd = b.add('power', 230, 0);
        const pa = b.add('pmos', 160, 40);
        const pb = b.add('pmos', 260, 40);
        const na = b.add('nmos', 200, 140);
        const nb = b.add('nmos', 200, 220);
        const gnd = b.add('ground', 220, 300);
        const out = b.add('probe', 360, 100, 'Y');
        b.wire(vdd, 'out', pa, 's').wire(vdd, 'out', pb, 's');
        b.wire(pa, 'd', out, 'p').wire(pb, 'd', out, 'p').wire(na, 'd', out, 'p');
        b.wire(nb, 'd', na, 's').wire(gnd, 'out', nb, 's');
        b.wire(A, 'out', pa, 'g').wire(A, 'out', na, 'g').wire(B, 'out', pb, 'g').wire(B, 'out', nb, 'g');
      }),
  },
  {
    id: 'hazard',
    title: 'Static hazard (glitch)',
    topic: 'Buses and electrical',
    summary: 'F = A·B + A′·C with B = C = 1 should always be 1, but a slow inverter opens a gap when A falls. Toggle A and watch the timeline: F glitches, G (with the consensus term B·C) does not.',
    build: () =>
      single('Static hazard', (b) => {
        const A = b.add('switch', 40, 80, 'A', { on: true });
        const one = b.add('const', 40, 200, '1');
        const inv = b.add('not', 140, 140, '', { delay: 4 });
        const g1 = b.add('and', 240, 40);
        const g2 = b.add('and', 240, 140);
        const g3 = b.add('and', 240, 240);
        const f = b.add('or', 380, 80);
        const g = b.add('or', 380, 200, '', { inputs: 3 });
        const F = b.add('led', 500, 90, 'F');
        const G = b.add('led', 500, 220, 'G', { color: 'green' });
        b.wire(A, 'out', g1, 'in0', 110).wire(one, 'out', g1, 'in1', 200).wire(A, 'out', inv, 'in0', 110).wire(inv, 'out', g2, 'in0');
        b.wire(one, 'out', g2, 'in1', 200).wire(one, 'out', g3, 'in0', 200).wire(one, 'out', g3, 'in1', 200);
        b.wire(g1, 'out', f, 'in0', 340).wire(g2, 'out', f, 'in1', 330).wire(g1, 'out', g, 'in0', 340).wire(g2, 'out', g, 'in1', 330).wire(g3, 'out', g, 'in2');
        b.wire(f, 'out', F, 'in').wire(g, 'out', G, 'in');
      }),
  },
  {
    id: 'sr-latch',
    title: 'SR latch from NOR gates',
    topic: 'Sequential',
    summary: 'Two cross-coupled NOR gates remember one bit. Press S to set Q, press R to reset it.',
    build: () =>
      single('SR latch (NOR)', (b) => {
        const R = b.add('button', 40, 40, 'R');
        const S = b.add('button', 40, 160, 'S');
        const n1 = b.add('nor', 180, 40);
        const n2 = b.add('nor', 200, 140);
        const Q = b.add('led', 320, 50, 'Q');
        const Qn = b.add('led', 320, 150, 'Q′', { color: 'blue' });
        b.wire(R, 'out', n1, 'in0').wire(S, 'out', n2, 'in1');
        b.wire(n1, 'out', n2, 'in0', 100).wire(n2, 'out', n1, 'in1', 120);
        b.wire(n1, 'out', Q, 'in').wire(n2, 'out', Qn, 'in');
        b.note(40, 240, 'Hold S or R to set or reset Q. Q starts unknown until you do.');
      }),
  },
  {
    id: 'counter',
    title: '4-bit counter',
    topic: 'Sequential',
    summary: 'A clock drives a 4-bit counter shown on a hex display. Run the clock, or step one tick at a time.',
    build: () =>
      single('4-bit counter', (b) => {
        const clk = b.add('clock', 40, 40, 'CLK');
        // CLR is on the counter's bottom edge, so its button sits below.
        const clr = b.add('button', 120, 220, 'CLR');
        const ctr = b.add('counter', 160, 20, '', { bits: 4 });
        const hex = b.add('hex', 400, 20, 'Count', { input: 'bus' });
        const co = b.add('led', 400, 150, 'Carry', { color: 'red' });
        b.wire(clk, 'out', ctr, 'clk', 120).wire(clr, 'out', ctr, 'clr').wire(ctr, 'q', hex, 'd', 350).wire(ctr, 'co', co, 'in', 360);
      }),
  },
  {
    id: 'shift-register',
    title: 'Shift register from D flip-flops',
    topic: 'Sequential',
    summary: 'Four D flip-flops pass DIN along one stage per rising clock edge. Set DIN, then step.',
    build: () =>
      single('Shift register', (b) => {
        const din = b.add('switch', 40, 80, 'DIN', { on: true });
        const clk = b.add('clock', 40, 200, 'CLK');
        let prev = din;
        let prevPin = 'out';
        for (let i = 0; i < 4; i++) {
          const x = 160 + 140 * i;
          const ff = b.add('dff', x, 60);
          b.wire(prev, prevPin, ff, 'd').wire(clk, 'out', ff, 'clk', x - 20);
          const led = b.add('led', x + 100, 0, `Q${i}`);
          b.wire(ff, 'q', led, 'in', x + 90);
          prev = ff;
          prevPin = 'q';
        }
      }),
  },
  {
    id: 'hierarchy',
    title: 'Full adder from half adders',
    topic: 'Hierarchy',
    summary: 'A project with two circuits: “Half adder” is used twice inside “Full adder”. Double-click a half-adder box to open it.',
    build: () => {
      const ha = halfAdderCircuit('k2');
      return { name: 'Adder hierarchy', main: 'main', circuits: [fullAdderCircuit('main', ha), ha] };
    },
  },
  {
    id: 'ripple4',
    title: '4-bit ripple-carry adder',
    topic: 'Hierarchy',
    summary: 'Four full-adder subcircuits chained by their carries, each built from two half adders: three levels of hierarchy.',
    build: () => {
      const ha = halfAdderCircuit('k3');
      const fa = fullAdderCircuit('k2', ha);
      using(fa, ha);
      const b = new CB('main', 'Ripple adder');
      const A = b.add('dip', 20, 60, 'A', { count: 4 });
      const B = b.add('dip', 20, 300, 'B', { count: 4 });
      const sa = b.add('splitter', 120, 60, '', { width: 4, fans: 4 });
      const sb = b.add('splitter', 120, 300, '', { width: 4, fans: 4 });
      const cin = b.add('const', 200, 0, 'Cin', { value: '0' });
      const join = b.add('splitter', 560, 120, '', { width: 4, fans: 4 }, 180);
      const hex = b.add('hex', 640, 60, 'Sum', { input: 'bus' });
      const co = b.add('led', 640, 380, 'Cout', { color: 'red' });
      b.wire(A, 'out', sa, 'c').wire(B, 'out', sb, 'c');
      let carryFrom = cin;
      let carryPin = 'out';
      for (let i = 0; i < 4; i++) {
        const f = b.add(subType('k2'), 300, 20 + 90 * i);
        b.wire(sa, `f${i}`, f, 'A', 200 + 10 * i).wire(sb, `f${i}`, f, 'B', 240 + 10 * i).wire(carryFrom, carryPin, f, 'Cin');
        b.wire(f, 'S', join, `f${i}`);
        carryFrom = f;
        carryPin = 'Cout';
      }
      b.wire(join, 'c', hex, 'd').wire(carryFrom, carryPin, co, 'in');
      return { name: 'Ripple adder', main: 'main', circuits: [b.c, fa, ha] };
    },
  },
];
