import { addComponent, connect, emptyCircuit } from '@ihatecircuits/core/edit';
import '@ihatecircuits/core/parts';
import type { Project } from '@ihatecircuits/core/types';
import { compile } from '@ihatecircuits/hdl';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportError, exportVerilog } from '../src';
import { ALL } from './corpus';
import { project, trace } from './helpers';

const haveIcarus = spawnSync('iverilog', ['-V']).status === 0;

describe('exportVerilog', () => {
  it('writes one module per circuit, callees first, with named ports and registers', () => {
    const text = exportVerilog(project(ALL.twice!.source, 'top'));
    expect(text.indexOf('module add4')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('module add4')).toBeLessThan(text.indexOf('module top'));
    expect(text).toContain('module top (input [3:0] a, input [3:0] b, input [3:0] c, output [4:0] ab, output [4:0] bc, output [5:0] all);');
    expect(text).toMatch(/add4 u_c\d+ \(\.a\(a\), \.b\(b\), \.s\(/);
    const counter = exportVerilog(project(ALL.counter!.source, 'counter'));
    expect(counter).toMatch(/always @\(posedge clk\) reg\w+ <= /);
  });

  for (const [name, { source, top }] of Object.entries(ALL)) {
    it(`${name}: the exported Verilog compiles and behaves like the original (checked with this compiler)`, () => {
      const verilog = exportVerilog(project(source, top));
      const again = compile(verilog, { top });
      expect(again.diagnostics.filter((d) => d.severity === 'error'), verilog).toEqual([]);
      const design = compile(source, { top }).design!;
      const m = design.modules.find((x) => x.name === design.top)!;
      const clock = m.ports.some((p) => p.name === 'clk') ? 'clk' : undefined;
      let seed = 7;
      const stimulus = Array.from({ length: 30 }, (_, k) =>
        Object.fromEntries(
          m.ports
            .filter((p) => p.dir === 'in' && p.name !== clock)
            .map((p) => {
              seed = (seed * 1103515245 + 12345) & 0x7fffffff;
              const v = p.name === 'rst' ? (k === 0 ? 1 : seed % 7 === 0 ? 1 : 0) : seed % 2 ** Math.min(p.width, 30);
              return [p.name, v.toString(2).padStart(p.width, '0')];
            }),
        ),
      );
      expect(trace({ source: verilog, top, clock, stimulus })).toEqual(trace({ source, top, clock, stimulus }));
    });

    it.skipIf(!haveIcarus)(`${name}: a standard Verilog simulator accepts the exported Verilog`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'gw-export-'));
      try {
        const file = join(dir, 'design.v');
        writeFileSync(file, exportVerilog(project(source, top)));
        const r = spawnSync('iverilog', ['-g2005', '-Wall', '-o', join(dir, 'out.vvp'), file], { encoding: 'utf8' });
        expect(r.stderr).not.toMatch(/error/i);
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  describe('nets that nothing drives (corpus 9044)', () => {
    /** Every `nNNN` name the export reads must be declared (or be a port). */
    const undeclared = (verilog: string) => {
      const declared = new Set([...verilog.matchAll(/^\s*(?:wire|reg)\s+(?:\[[^\]]+\]\s*)?(\w+);/gm)].map((m) => m[1]!));
      return [...new Set([...verilog.matchAll(/\bn\d+\b/g)].map((m) => m[0]))].filter((n) => !declared.has(n));
    };

    it('a concatenation of undriven wires declares its bus', () => {
      const src = 'module m (input [1:0] a, output [3:0] y);\n wire [1:0] u;\n wire [1:0] v;\n assign y = {u, v} | {a, a};\nendmodule';
      const verilog = exportVerilog(project(src, 'm'));
      expect(undeclared(verilog), verilog).toEqual([]);
    });

    it('a concatenation of an input and undriven wires is assigned from its pieces', () => {
      const src = "module m (input [1:0] a, output [3:0] y, output [1:0] z);\n wire [1:0] u;\n wire [3:0] c;\n assign c = {u, a};\n assign y = c | 4'b0001;\n assign z = c[3:2];\nendmodule";
      const verilog = exportVerilog(project(src, 'm'));
      expect(undeclared(verilog), verilog).toEqual([]);
      expect(verilog).not.toMatch(/assign a\b/);
      expect(verilog).toMatch(/assign n\d+ = \{[^}]*a\[1\], a\[0\]\}/);
    });
  });

  it('exports parts the lowering does not use: NAND and NOR gates with three inputs', () => {
    let c = emptyCircuit('gates');
    const add = (type: string, props: Record<string, unknown>, label = '') => {
      const r = addComponent(c, { type, x: 0, y: 0, props, label });
      c = r.circuit;
      return r.id;
    };
    const wire = (a: string, ap: string, b: string, bp: string) => {
      const r = connect(c, { comp: a, pin: ap }, { comp: b, pin: bp });
      if ('error' in r) throw new Error(r.error);
      c = r.circuit;
    };
    const [a, b, d] = [add('pin', { io: 'in' }, 'a'), add('pin', { io: 'in' }, 'b'), add('pin', { io: 'in' }, 'd')];
    const nand = add('nand', { inputs: 3 });
    const nor = add('nor', { inputs: 2 });
    const y = add('pin', { io: 'out' }, 'y');
    const z = add('pin', { io: 'out' }, 'z');
    wire(a, 'p', nand, 'in0');
    wire(b, 'p', nand, 'in1');
    wire(d, 'p', nand, 'in2');
    wire(a, 'p', nor, 'in0');
    wire(b, 'p', nor, 'in1');
    wire(nand, 'out', y, 'p');
    wire(nor, 'out', z, 'p');
    const p: Project = { name: 'gates', main: 'main', circuits: [c] };
    const text = exportVerilog(p);
    expect(text).toContain('~(a & b & d)');
    expect(text).toContain('~(a | b)');
    expect(compile(text, { top: 'gates' }).diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('refuses a part it cannot express instead of exporting it wrongly', () => {
    let c = emptyCircuit('sw');
    const sw = addComponent(c, { type: 'switch', x: 0, y: 0 });
    c = sw.circuit;
    expect(() => exportVerilog({ name: 'sw', main: 'main', circuits: [c] })).toThrow(ExportError);
    const led = addComponent(emptyCircuit('t'), { type: 'tunnel', x: 0, y: 0 });
    expect(() => exportVerilog({ name: 't', main: 'main', circuits: [led.circuit] })).toThrow(/cannot be exported/);
  });
});
