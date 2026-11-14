import { compile, type CycleSample, type TraceRequest, type TraceResult } from '@ihatecircuits/hdl';
import { describe, expect, it } from 'vitest';
import { compareTraces } from '../../../tools/hdl-fuzz/src/compare';
import { runExportedViaIverilog } from '../../../tools/hdl-fuzz/src/extra-runners';
import { iverilogAvailable, iverilogRunner } from '../../../tools/hdl-fuzz/src/iverilog';
import { lowerToProject, runSimulator } from '../src';

/**
 * Regression tests for the bugs an adversarial review found in the Verilog pipeline.
 * Where a standard simulator defines the right answer, the circuit is compared with Icarus
 * (and so is Verilog exported back from the circuit); those tests skip when Icarus is missing.
 */

const haveIcarus = iverilogAvailable();

function stimulus(widths: Record<string, number>, n: number, seed = 5): Array<Record<string, string>> {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: n }, () => Object.fromEntries(Object.entries(widths).map(([name, w]) => [name, Array.from({ length: w }, () => (next() < 0.5 ? '0' : '1')).join('')])));
}

const ok = (r: TraceResult) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

interface Verdict {
  ref: TraceResult;
  ours: TraceResult;
  oursAgrees: boolean;
  exportAgrees: boolean;
  message: string;
}

async function against(source: string, stim: Array<Record<string, string>>, opts: { clock?: string; top?: string } = {}): Promise<Verdict> {
  const req: TraceRequest = { source, top: opts.top ?? 'm', clock: opts.clock, stimulus: stim };
  const ref = await iverilogRunner(req);
  const ours = await runSimulator(req);
  const exported = await runExportedViaIverilog(req);
  const a = compareTraces(ref, ours);
  const b = compareTraces(ref, exported);
  return { ref, ours, oursAgrees: a.ok, exportAgrees: b.ok, message: `circuit: ${a.ok ? 'ok' : a.message}; export: ${b.ok ? 'ok' : b.message}` };
}

const samples = (r: TraceResult, port: string, phase: 'pre' | 'post'): string[] => ok(r).cycles.map((c: CycleSample) => c[phase][port]!);

describe.skipIf(!haveIcarus)('against Icarus', () => {
  describe('an expression on an instance input port (B2)', () => {
    const sub = 'module sub8 (input [7:0] a, output [7:0] y);\n assign y = a;\nendmodule\n';
    const design = (expr: string) => `${sub}module m (input [3:0] p, input [3:0] q, input c, output [7:0] y);\n sub8 u (.a(${expr}), .y(y));\nendmodule`;

    for (const expr of ['p + q', '~p', 'c ? p + q : q', '(p & q) + 4\'d9', '{p, q} ^ 8\'h5a']) {
      it(`.a(${expr})`, async () => {
        const v = await against(design(expr), stimulus({ p: 4, q: 4, c: 1 }, 40));
        expect(v.message).toBe('circuit: ok; export: ok');
      });
    }

    it('p + q drops the carry before it is widened', async () => {
      const v = await against(design('p + q'), [{ p: '1111', q: '0110', c: '0' }]);
      expect(samples(v.ref, 'y', 'pre')).toEqual(['00000101']);
      expect(samples(v.ours, 'y', 'pre')).toEqual(['00000101']);
    });
  });

  describe('undriven nets read as unknown (B4)', () => {
    it('a[0] | u where u is never driven', async () => {
      const src = 'module m (input [3:0] a, output y);\n wire u;\n assign y = a[0] | u;\nendmodule';
      const v = await against(src, stimulus({ a: 4 }, 16));
      expect(v.message).toBe('circuit: ok; export: ok');
      const ys = samples(v.ours, 'y', 'pre');
      expect(ys).toContain('x');
      expect(ys).toContain('1');
    });

    it('a == u where u is never driven is always unknown', async () => {
      const src = 'module m (input [3:0] a, output y);\n wire [3:0] u;\n assign y = a == u;\nendmodule';
      const v = await against(src, stimulus({ a: 4 }, 16));
      expect(v.message).toBe('circuit: ok; export: ok');
      expect(new Set(samples(v.ours, 'y', 'pre'))).toEqual(new Set(['x']));
    });

    it('a multi-bit undriven wire used as a condition and as data (the export splits a bus nothing drives)', async () => {
      const src = 'module m (input [6:0] i, output [6:0] y);\n wire [6:0] u;\n assign y = u ? u : i;\nendmodule';
      const v = await against(src, stimulus({ i: 7 }, 12));
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    // Corpus 9044: "Unable to bind wire/reg/memory 'n520['sd1:'sd0]'". A concatenation is a splitter whose bus has no
    // driver of its own, so the export has to work out which way it runs and declare the bus either way.
    it('a concatenation of nothing but undriven wires, read by a gate (a splitter bus that is never declared)', async () => {
      const src = "module m (input [1:0] a, output [3:0] y);\n wire [1:0] u;\n wire [1:0] v;\n assign y = {u, v} | {a, a};\nendmodule";
      const v = await against(src, stimulus({ a: 2 }, 8));
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    it('a concatenation of an input pin and undriven wires is assembled from its pieces, not split (9044)', async () => {
      const src = "module m (input [1:0] a, output [3:0] y, output [1:0] z);\n wire [1:0] u;\n wire [3:0] c;\n assign c = {u, a};\n assign y = c | 4'b0001;\n assign z = c[3:2];\nendmodule";
      const v = await against(src, stimulus({ a: 2 }, 8));
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    it('a reg that is never assigned is unknown, and the compiler warns that hardware would float', async () => {
      const src = 'module m (input a, output reg y);\nendmodule';
      const v = await against(src, stimulus({ a: 1 }, 3));
      expect(v.oursAgrees).toBe(true);
      expect(samples(v.ref, 'y', 'pre')).toEqual(['x', 'x', 'x']);
      expect(samples(v.ours, 'y', 'pre')).toEqual(['z', 'z', 'z']);
      expect(compile(src).diagnostics.filter((d) => d.code === 'undriven')).toMatchObject([{ severity: 'warning', code: 'undriven' }]);
    });

    it('a register fed by an undriven wire loads unknown (Verilog keeps the z, a known difference)', async () => {
      const src = 'module m (input clk, output reg q);\n wire u;\n always @(posedge clk) q <= u;\nendmodule';
      const v = await against(src, stimulus({}, 3), { clock: 'clk' });
      expect(v.exportAgrees).toBe(true);
      expect(samples(v.ref, 'q', 'post')).toEqual(['z', 'z', 'z']);
      expect(samples(v.ours, 'q', 'post')).toEqual(['x', 'x', 'x']);
    });
  });

  // IEEE 1364-2005 Table 5-14 gives ~z = x. Icarus returns z when a bare `~` in a continuous assignment sees a vector
  // that is entirely z, whether the net is undriven or driven with z. Every other operator, partly-z operands and the
  // same `~` in a procedural block give x. Our x is the standard's answer; see tools/hdl-fuzz/README.md.
  describe('Icarus keeps z through a bare ~ of an all-z vector, the standard says x', () => {
    const run = async (source: string, clock?: string) => {
      const req: TraceRequest = { source, top: 'm', clock, stimulus: stimulus({}, 2) };
      const phase = clock ? 'post' : 'pre';
      return {
        ref: samples(await iverilogRunner(req), 'o', phase)[0]!,
        ours: samples(await runSimulator(req), 'o', phase)[0]!,
        exported: samples(await runExportedViaIverilog(req), 'o', phase)[0]!,
      };
    };
    const comb = (rhs: string, decl = 'wire [3:0] u;') => `module m (output [3:0] o);\n ${decl}\n assign o = ${rhs};\nendmodule`;

    it('assign o = ~u with u never driven: Icarus zzzz, ours xxxx, the export (through Icarus) zzzz', async () => {
      expect(await run(comb('~u'))).toEqual({ ref: 'zzzz', ours: 'xxxx', exported: 'zzzz' });
    });

    // Our compiler has no x or z literals yet, so these two are checked in the reference simulator alone.
    const refOnly = async (rhs: string, decl: string) => samples(await iverilogRunner({ source: comb(rhs, decl), top: 'm', stimulus: stimulus({}, 1) }), 'o', 'pre')[0];

    it('it is the bare inverter, not the undriven net: a z driver gives the same, and any other operator gives x', async () => {
      expect(await refOnly('~u', "wire [3:0] u;\n assign u = 4'bzzzz;")).toBe('zzzz');
      for (const rhs of ["~u & 4'hF", "u ^ 4'h0", "u | 4'h0", "u + 4'd0", "~(u | u)"]) {
        expect(await run(comb(rhs)), rhs).toEqual({ ref: 'xxxx', ours: 'xxxx', exported: 'xxxx' });
      }
    });

    it('a vector that is only partly z inverts to x on those bits', async () => {
      expect(await refOnly('~u', "wire [3:0] u;\n assign u = 4'bzz01;")).toBe('xx10');
    });

    it('r <= ~u: Icarus xxxx (a procedural ~ is correct), ours xxxx, the export zzzz because it hoists the ~ into an assign', async () => {
      const src = 'module m (input clk, output reg [3:0] o);\n wire [3:0] u;\n always @(posedge clk) o <= ~u;\nendmodule';
      expect(await run(src, 'clk')).toEqual({ ref: 'xxxx', ours: 'xxxx', exported: 'zzzz' });
    });
  });

  describe('a derived clock sees the data from before the edge (B5)', () => {
    const gated = `module m (input clk, input en, input [3:0] d, output reg [3:0] q, output reg [3:0] r);
  wire g;
  assign g = clk & en;
  always @(posedge clk) q <= d;
  always @(posedge g) r <= q;
endmodule`;

    it('g = clk & en', async () => {
      const v = await against(gated, stimulus({ en: 1, d: 4 }, 40), { clock: 'clk' });
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    it('a clock through several gates and an inverter pair', async () => {
      const src = `module m (input clk, input en, input [3:0] d, output reg [3:0] q, output reg [3:0] r, output reg [3:0] s);
  wire g1;
  wire g2;
  wire g3;
  assign g1 = clk & en;
  assign g2 = ~(~g1);
  assign g3 = g2 | 1'b0;
  always @(posedge clk) q <= d;
  always @(posedge g3) r <= q + 4'd1;
  always @(posedge g1) s <= r ^ q;
endmodule`;
      const v = await against(src, stimulus({ en: 1, d: 4 }, 40, 11), { clock: 'clk' });
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    it('the compiler warns about the gated clock', () => {
      expect(compile(gated).diagnostics.filter((d) => d.code === 'gated-clock')).toHaveLength(1);
    });
  });

  describe('if (x) on an unreset reg (B1)', () => {
    const src = `module m (input clk, input a, output reg [3:0] r, output reg c);
  always @(posedge clk) begin
    c <= a;
    if (c) r <= 4'd1; else r <= 4'd2;
  end
endmodule`;

    it('Verilog takes the else branch, the circuit merges the branches, and the compiler said so', async () => {
      const v = await against(src, [{ a: '1' }, { a: '1' }, { a: '0' }], { clock: 'clk' });
      expect(samples(v.ref, 'r', 'post')).toEqual(['0010', '0001', '0001']);
      expect(samples(v.ours, 'r', 'post')).toEqual(['00xx', '0001', '0001']);
      expect(v.oursAgrees).toBe(false);
      expect(compile(src).diagnostics.filter((d) => d.code === 'if-unknown-condition')).toHaveLength(1);
    });

    it('with a reset both agree', async () => {
      const reset = `module m (input clk, input rst, input a, output reg [3:0] r, output reg c);
  always @(posedge clk) begin
    if (rst) begin
      c <= 1'b0;
      r <= 4'd0;
    end else begin
      c <= a;
      if (c) r <= 4'd1; else r <= 4'd2;
    end
  end
endmodule`;
      const stim = [{ rst: '1', a: '1' }, ...stimulus({ rst: 1, a: 1 }, 30, 3)];
      const v = await against(reset, stim, { clock: 'clk' });
      expect(compile(reset).diagnostics.filter((d) => d.code === 'if-unknown-condition')).toHaveLength(0);
      expect(v.oursAgrees).toBe(true);
    });
  });

  describe('comparisons and conditions wider than 32 bits (B9)', () => {
    const bin32 = (v: number) => (v >>> 0).toString(2).padStart(32, '0');
    const wideStimulus = (): Array<Record<string, string>> => {
      const out = stimulus({ a: 32, b: 32, c: 1 }, 30, 17);
      for (const [a, b] of [[0xffffffff, 1], [0x80000000, 0x80000000], [0x10, 5], [0, 0], [1, 0xffffffff], [0x12345678, 0xedcba988]]) {
        out.push({ a: bin32(a), b: bin32(b), c: '1' }, { a: bin32(a), b: bin32(b), c: '0' });
      }
      return out;
    };
    const wide = (expr: string, ports = 'input [31:0] a, input [31:0] b, input c') => `module m (${ports}, output y);\n assign y = ${expr};\nendmodule`;
    const cases: Array<[string, string]> = [
      ["a + b == 'h100000000", 'the carry out of bit 31 reaches the upper half'],
      ["a + b != 'h100000000", 'the same with !='],
      ["~a == 'h000000000", 'complement gains ones above bit 31'],
      ["{a[7:0], b} == 'h1000000005", 'a 40-bit concatenation against a 40-bit literal'],
      ["(c ? a + b : a) == 'h1ffffffff", 'a ?: inside the wide comparison'],
      ["{a, b} != {b, a}", 'two 64-bit concatenations'],
      ["{a[3:0], b} == {4'h1, b}", 'a 36-bit concatenation against another'],
      ["a == 'h000000000", 'leading zero digits only'],
      ["(a ^ b) + a == 'h100000000", 'a chain with a carry'],
    ];
    for (const [expr, what] of cases) {
      it(`${expr}: ${what}`, async () => {
        const v = await against(wide(expr), wideStimulus());
        expect(v.message).toBe('circuit: ok; export: ok');
      });
    }

    it('a condition wider than 32 bits', async () => {
      const src = "module m (input [31:0] a, input [31:0] b, input c, output y, output reg q);\n assign y = {a[7:0], b} ? 1'b1 : 1'b0;\n always @(posedge clk) if ({a[7:0], b}) q <= 1'b1; else q <= 1'b0;\nendmodule".replace('input c,', 'input c, input clk,');
      const v = await against(src, wideStimulus().map((s) => ({ ...s, a: s.a!.replace(/^.{24}/, '0'.repeat(24)) })), { clock: 'clk' });
      expect(v.oursAgrees).toBe(true);
    });
  });

  describe('diagnostic fixes keep the semantics', () => {
    it('a == a literal with leading zeros beyond 32 bits', async () => {
      const src = "module m (input [3:0] a, output y, output z);\n assign y = a == 'h000000000;\n assign z = 'h000000005 != a;\nendmodule";
      const v = await against(src, stimulus({ a: 4 }, 40));
      expect(v.message).toBe('circuit: ok; export: ok');
    });

    it('a bit-select, a part-select and a concatenation after declarations in order', async () => {
      const src = 'module m (input [7:0] a, output [3:0] y);\n wire [7:0] w;\n assign w = {a[3:0], a[7:4]};\n assign y = w[5:2] ^ a[3:0];\nendmodule';
      const v = await against(src, stimulus({ a: 8 }, 40));
      expect(v.message).toBe('circuit: ok; export: ok');
    });
  });
});

describe('the pipeline never throws (B7)', () => {
  const wrap = (expr: string) => `module m (input [3:0] a, output [3:0] y);\n assign y = ${expr};\nendmodule`;
  const req = (source: string): TraceRequest => ({ source, top: 'm', stimulus: [{ a: '0011' }] });

  it('5,000 nested parentheses return a diagnostic', async () => {
    const r = await runSimulator(req(wrap(`${'('.repeat(5000)}a${')'.repeat(5000)}`)));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('too-deep');
  });

  it('a 10,000-term chain compiles and lowers to a circuit', () => {
    const compiled = compile(wrap(Array(10000).fill('a').join(' + ')));
    expect(compiled.design).toBeDefined();
    const main = lowerToProject(compiled.design!).circuits[0]!;
    expect(Object.values(main.components).filter((c) => c.type === 'adder')).toHaveLength(9999);
  });

  it('a 1,000-term chain runs and adds up', async () => {
    const r = ok(await runSimulator(req(wrap(Array(1000).fill('a').join(' + ')))));
    expect(r.cycles[0]!.pre.y).toBe(((3 * 1000) % 16).toString(2).padStart(4, '0'));
  });

  it('an internal failure in compile comes back as an error result', async () => {
    const hostile = { source: wrap('a'), stimulus: [], get top(): string { throw new Error('boom'); } } as unknown as TraceRequest;
    expect(await runSimulator(hostile)).toMatchObject({ ok: false });
  });
});

describe('lowering is linear in the size of the design', () => {
  function chain(n: number): string {
    const lines = ['module m (input [7:0] a, input [7:0] b, input [7:0] c, output [7:0] y);'];
    for (let i = 1; i <= n; i++) lines.push(` wire [7:0] w${i};\n assign w${i} = ${i === 1 ? 'a' : `w${i - 1}`} ${['^', '+', '&', '|'][i % 4]} ${['a', 'b', 'c'][i % 3]};`);
    lines.push(` assign y = w${n};`, 'endmodule');
    return lines.join('\n');
  }

  function timed(n: number) {
    const design = compile(chain(n)).design!;
    lowerToProject(design);
    const t0 = performance.now();
    const project = lowerToProject(design);
    const ms = performance.now() - t0;
    const main = project.circuits[0]!;
    return { ms, parts: Object.keys(main.components).length, wires: Object.keys(main.wires).length };
  }

  it('a design of 400 parts lowers quickly', () => {
    const r = timed(400);
    expect(r.parts).toBeGreaterThanOrEqual(400);
    expect(r.ms).toBeLessThan(300);
  });

  it('1,600 wires lower in well under the quadratic time of before', () => {
    const r = timed(800);
    expect(r.wires).toBeGreaterThanOrEqual(1600);
    expect(r.ms).toBeLessThan(300);
  });
});

describe('lowering facts', () => {
  it('gives the registers a delay longer than the deepest clock path, only when a clock goes through logic', () => {
    const gated = `module m (input clk, input en, input d, output reg q, output reg r);
  wire g;
  assign g = clk & en;
  always @(posedge clk) q <= d;
  always @(posedge g) r <= q;
endmodule`;
    const plain = 'module m (input clk, input d, output reg q);\n always @(posedge clk) q <= d;\nendmodule';
    const delays = (src: string) =>
      Object.values(lowerToProject(compile(src).design!).circuits[0]!.components)
        .filter((c) => c.type === 'register')
        .map((c) => c.props.delay);
    expect(delays(gated)).toEqual([2, 2]);
    expect(delays(plain)).toEqual([1]);
  });

  it('puts a junction on an undriven net so its readers are wired to something', () => {
    const project = lowerToProject(compile('module m (input a, output y);\n wire u;\n assign y = a | u;\nendmodule').design!);
    const main = project.circuits[0]!;
    const junction = Object.values(main.components).find((c) => c.type === 'junction');
    expect(junction).toBeDefined();
    expect(Object.values(main.wires).some((w) => w.from.comp === junction!.id || w.to.comp === junction!.id)).toBe(true);
  });
});
