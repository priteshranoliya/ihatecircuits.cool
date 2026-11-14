import { compile } from '@ihatecircuits/hdl';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL } from './corpus';
import { trace } from './helpers';

/**
 * Spot checks against a standard Verilog simulator (Icarus), skipped when it is
 * not installed. The full differential campaign lives in tools/hdl-fuzz; these
 * keep the width rules and the unknown-value behaviour honest in plain `npm test`.
 */

const haveIcarus = spawnSync('iverilog', ['-V']).status === 0;

interface Port {
  name: string;
  width: number;
  dir: string;
}

/** Run a design under the trace protocol in Icarus and return one record of output values per sample. */
function icarus(source: string, top: string, clock: string | undefined, ports: Port[], stimulus: Record<string, string>[]): Record<string, string>[] {
  const outs = ports.filter((p) => p.dir === 'out');
  const show = (tag: string) => `    $display("${tag} ${outs.map((p) => `${p.name}=%b`).join(' ')}", ${outs.map((p) => p.name).join(', ')});`;
  const bench = [
    'module tb;',
    ...ports.filter((p) => p.dir === 'in').map((p) => `  reg [${p.width - 1}:0] ${p.name} = 0;`),
    ...outs.map((p) => `  wire [${p.width - 1}:0] ${p.name};`),
    `  ${top} dut (${ports.map((p) => `.${p.name}(${p.name})`).join(', ')});`,
    '  initial begin',
    ...stimulus.flatMap((s) => [
      ...Object.entries(s).map(([k, v]) => `    ${k} = ${v.length}'b${v};`),
      '    #1;',
      show('PRE'),
      ...(clock ? [`    ${clock} = 1;`, '    #1;', show('POST'), `    ${clock} = 0;`, '    #1;'] : []),
    ]),
    '    $finish;',
    '  end',
    'endmodule',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'gw-icarus-'));
  try {
    writeFileSync(join(dir, 't.v'), `${source}\n${bench}`);
    const c = spawnSync('iverilog', ['-g2005', '-o', join(dir, 't.vvp'), join(dir, 't.v')], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error(c.stderr);
    const r = spawnSync('vvp', [join(dir, 't.vvp')], { encoding: 'utf8' });
    return r.stdout
      .split('\n')
      .filter((l) => /^(PRE|POST) /.test(l))
      .map((l) => Object.fromEntries(l.split(' ').slice(1).map((kv) => kv.split('=') as [string, string])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function differences(source: string, top: string, stimulus: Record<string, string>[]) {
  const design = compile(source, { top }).design!;
  const m = design.modules.find((x) => x.name === design.top)!;
  const clock = m.ports.some((p) => p.name === 'clk') ? 'clk' : undefined;
  const ports = m.ports.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
  const ref = icarus(source, top, clock, ports, stimulus);
  const got = trace({ source, top, clock, stimulus });
  const out: string[] = [];
  let i = 0;
  got.cycles.forEach((cy, k) => {
    for (const which of clock ? (['pre', 'post'] as const) : (['pre'] as const)) {
      const want = ref[i++]!;
      for (const [name, v] of Object.entries(cy[which])) if (v !== want[name]) out.push(`cycle ${k} ${which} ${name}: ihatecircuits ${v}, icarus ${want[name]}`);
    }
  });
  return { out, samples: i };
}

let seed = 2024n;
const rand = (n: number) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return Number((seed >> 33n) % BigInt(n));
};

describe.skipIf(!haveIcarus)('against Icarus Verilog', () => {
  for (const [name, { source, top }] of Object.entries(ALL)) {
    it(`${name} gives the same trace, unknown power-on values included`, () => {
      const design = compile(source, { top }).design!;
      const m = design.modules.find((x) => x.name === design.top)!;
      const ins = m.ports.filter((p) => p.dir === 'in' && p.name !== 'clk');
      const stimulus = Array.from({ length: 60 }, (_, k) =>
        Object.fromEntries(
          ins.map((p) => {
            const v = p.name === 'rst' ? (k > 0 && rand(8) === 0 ? 1 : 0) : p.name === 'en' ? (rand(4) ? 1 : 0) : rand(2 ** Math.min(p.width, 30));
            return [p.name, v.toString(2).padStart(p.width, '0')];
          }),
        ),
      );
      const { out, samples } = differences(source, top, stimulus);
      expect(samples).toBeGreaterThan(0);
      expect(out).toEqual([]);
    });
  }

  it('random expressions size their operands the way the standard says (section 5.4)', () => {
    const inputs = [['a', 8], ['b', 8], ['c', 4], ['d', 1], ['e', 12]] as const;
    const part = () => {
      const [n, w] = inputs[rand(inputs.length)]!;
      return rand(3) === 0 && w > 1 ? `${n}[${rand(w)}]` : n;
    };
    const leaf = (): string => {
      const k = rand(8);
      if (k < 3) return inputs[rand(inputs.length)]![0];
      if (k === 3) return part();
      if (k === 4) {
        const [n, w] = inputs[rand(inputs.length)]!;
        if (w < 2) return n;
        const hi = 1 + rand(w - 1);
        return `${n}[${hi}:${rand(hi)}]`;
      }
      if (k === 5) return String(rand(40));
      if (k === 6) {
        const w = 1 + rand(10);
        return `${w}'d${rand(2 ** w)}`;
      }
      return `{${part()}, ${part()}}`;
    };
    const expr = (depth: number): string => {
      if (depth === 0 || rand(4) === 0) return leaf();
      switch (rand(6)) {
        case 0:
          return `~(${expr(depth - 1)})`;
        case 1:
          return `(${expr(depth - 1)} ${['&', '|', '^', '~^'][rand(4)]} ${expr(depth - 1)})`;
        case 2:
        case 3:
          return `(${expr(depth - 1)} + ${expr(depth - 1)})`;
        case 4:
          return `(${expr(depth - 1)} ${rand(2) ? '==' : '!='} ${expr(depth - 1)})`;
        default:
          return `(${expr(depth - 1)} ? ${expr(depth - 1)} : ${expr(depth - 1)})`;
      }
    };
    let samples = 0;
    for (let round = 0; round < 25; round++) {
      const outs = Array.from({ length: 4 }, (_, i) => ({ name: `y${i}`, w: 1 + rand(14), e: expr(3) }));
      const source = `module m (input [7:0] a, input [7:0] b, input [3:0] c, input d, input [11:0] e, ${outs.map((o) => `output [${o.w - 1}:0] ${o.name}`).join(', ')});\n${outs.map((o) => `  assign ${o.name} = ${o.e};`).join('\n')}\nendmodule`;
      const stimulus = Array.from({ length: 20 }, () => Object.fromEntries(inputs.map(([n, w]) => [n, rand(2 ** w).toString(2).padStart(w, '0')])));
      const r = differences(source, 'm', stimulus);
      samples += r.samples;
      expect(r.out, source).toEqual([]);
    }
    expect(samples).toBe(25 * 20);
  });
});
