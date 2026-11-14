import { execFile, type ExecFileException } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CycleSample, TracePort, TraceRequest, TraceResult, TraceRunner } from '@ihatecircuits/hdl/trace';
import { parseTopPorts, type HeaderPort } from './header';

const TB_TOP = '__gw_tb';
const DUT = '__gw_dut';
const TAG = '@@GW';
const DEFAULT_TIMEOUT_MS = 30_000;

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function iverilogAvailable(): boolean {
  return onPath('iverilog') && onPath('vvp');
}

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, killSignal: 'SIGKILL' }, (err: ExecFileException | null, stdout, stderr) => {
      const timedOut = !!err && (err.killed === true || err.signal === 'SIGKILL');
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut });
    });
  });
}

const bits = (value: string, width: number) => `${width}'b${value}`;

/**
 * Testbench for the cycle protocol in packages/hdl/src/trace.ts. All driving and sampling
 * happens in one initial block, one time unit apart, so nothing samples in the time step of
 * a clock edge. A cycle that omits an input holds its previous value.
 */
export function buildTestbench(req: TraceRequest, ports: HeaderPort[]): string {
  const clock = req.clock;
  const inputs = ports.filter((p) => p.dir === 'in');
  const outputs = ports.filter((p) => p.dir === 'out');
  const driven = inputs.filter((p) => p.name !== clock);
  const sig = (p: HeaderPort) => (p.range ? `${p.range} ` : '') + p.name;

  const lines: string[] = [`module ${TB_TOP};`];
  for (const p of inputs) lines.push(`  reg ${sig(p)} = ${bits('0'.repeat(p.width), p.width)};`);
  for (const p of outputs) lines.push(`  wire ${sig(p)};`);
  lines.push(`  ${req.top} ${DUT} (${ports.map((p) => `.${p.name}(${p.name})`).join(', ')});`);
  const dump = (phase: 'PRE' | 'POST', k: number) =>
    `    $display("${TAG} ${phase} ${k}${outputs.map(() => ' %b').join('')}"${outputs.map((p) => `, ${p.name}`).join('')});`;
  lines.push('  initial begin', '    #1;');
  req.stimulus.forEach((cycle, k) => {
    for (const p of driven) {
      const v = cycle[p.name];
      if (v !== undefined) lines.push(`    ${p.name} = ${bits(v, p.width)};`);
    }
    lines.push('    #1;', dump('PRE', k));
    if (clock) lines.push(`    ${clock} = 1'b1;`);
    lines.push('    #1;', dump('POST', k));
    if (clock) lines.push(`    ${clock} = 1'b0;`);
    lines.push('    #1;');
  });
  lines.push('    $finish;', '  end', 'endmodule', '');
  return lines.join('\n');
}

function validate(req: TraceRequest, ports: HeaderPort[]): string | undefined {
  if (req.clock !== undefined) {
    const c = ports.find((p) => p.name === req.clock);
    if (!c || c.dir !== 'in' || c.width !== 1) return `clock "${req.clock}" is not a 1-bit input of "${req.top}"`;
  }
  for (const [k, cycle] of req.stimulus.entries()) {
    for (const [name, v] of Object.entries(cycle)) {
      const p = ports.find((q) => q.name === name);
      if (!p || p.dir !== 'in' || name === req.clock) return `stimulus[${k}] drives "${name}", which is not a non-clock input of "${req.top}"`;
      if (!/^[01xzXZ]+$/.test(v) || v.length !== p.width) return `stimulus[${k}].${name} = "${v}" is not a ${p.width}-bit binary string`;
    }
  }
  return undefined;
}

function cleanMessage(text: string, dir: string): string {
  return text.split(dir + '/').join('').trim();
}

export interface CompileCheck {
  ok: boolean;
  /** Raw iverilog stderr (errors and warnings), with the temp directory removed. */
  stderr: string;
}

/** Compile `source` alone (no testbench). `-Wall` turns on iverilog's lint warnings. */
export async function compileCheck(source: string, top: string, opts: { wall?: boolean; timeoutMs?: number } = {}): Promise<CompileCheck> {
  const dir = mkdtempSync(join(tmpdir(), 'hdl-fuzz-'));
  try {
    writeFileSync(join(dir, 'design.v'), source);
    const args = ['-g2005', ...(opts.wall ? ['-Wall'] : []), '-s', top, '-o', 'sim.vvp', 'design.v'];
    const r = await run('iverilog', args, dir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ok: r.code === 0 && !r.timedOut, stderr: cleanMessage(r.stderr, dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WIDTH_WARNING = /^\S+:\d+: warning: Port \d+ \([^)]*\) of module \S+ expects \d+ bit\(s\), given \d+\.$/;
const WIDTH_WARNING_DETAIL = /^\S+:\d+:\s+: (?:Padding|Pruning)(?: \(signed\))? \d+ high bits of the (?:port|expression)\.$/;

/**
 * Drops iverilog's port-width-mismatch warnings (and their Padding/Pruning detail line) and
 * returns whatever else it printed. The generator only produces these on purpose, when its
 * `widthMismatch` feature is on, so every other warning stays a failure.
 */
export function withoutWidthMismatchWarnings(stderr: string): string {
  const keep: string[] = [];
  let skipDetail = false;
  for (const line of stderr.split('\n')) {
    if (WIDTH_WARNING.test(line)) skipDetail = true;
    else if (skipDetail && WIDTH_WARNING_DETAIL.test(line)) skipDetail = false;
    else {
      skipDetail = false;
      keep.push(line);
    }
  }
  return keep.join('\n').trim();
}

function parseOutput(stdout: string, ports: HeaderPort[], cycles: number): TraceResult {
  const outputs = ports.filter((p) => p.dir === 'out');
  const slots: Array<Partial<CycleSample>> = Array.from({ length: cycles }, () => ({}));
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(TAG + ' ')) continue;
    const [, phase, k, ...vals] = line.trim().split(/\s+/);
    const slot = slots[Number(k)];
    if (!slot || (phase !== 'PRE' && phase !== 'POST') || vals.length !== outputs.length) return { ok: false, error: `unparseable simulator output: ${line}` };
    const sample: Record<string, string> = {};
    outputs.forEach((p, i) => {
      sample[p.name] = vals[i]!;
    });
    slot[phase === 'PRE' ? 'pre' : 'post'] = sample;
  }
  const result: CycleSample[] = [];
  for (const [k, s] of slots.entries()) {
    if (!s.pre || !s.post) return { ok: false, error: `simulator produced no sample for cycle ${k}` };
    result.push({ pre: s.pre, post: s.post });
  }
  const tracePorts: TracePort[] = ports.map(({ name, width, dir }) => ({ name, width, dir }));
  return { ok: true, ports: tracePorts, cycles: result };
}

export function makeIverilogRunner(opts: { timeoutMs?: number } = {}): TraceRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req: TraceRequest): Promise<TraceResult> => {
    let ports: HeaderPort[];
    try {
      ports = parseTopPorts(req.source, req.top);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const bad = validate(req, ports);
    if (bad) return { ok: false, error: bad };

    const dir = mkdtempSync(join(tmpdir(), 'hdl-fuzz-'));
    try {
      writeFileSync(join(dir, 'design.v'), req.source);
      writeFileSync(join(dir, 'tb.v'), buildTestbench(req, ports));
      const c = await run('iverilog', ['-g2005', '-s', TB_TOP, '-o', 'sim.vvp', 'design.v', 'tb.v'], dir, timeoutMs);
      if (c.timedOut) return { ok: false, error: `iverilog timed out after ${timeoutMs} ms` };
      if (c.code !== 0) return { ok: false, error: cleanMessage(c.stderr || `iverilog exited with code ${c.code}`, dir) };
      const s = await run('vvp', ['-n', 'sim.vvp'], dir, timeoutMs);
      if (s.timedOut) return { ok: false, error: `vvp timed out after ${timeoutMs} ms` };
      if (s.code !== 0) return { ok: false, error: cleanMessage(s.stderr || s.stdout || `vvp exited with code ${s.code}`, dir) };
      return parseOutput(s.stdout, ports, req.stimulus.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export const iverilogRunner: TraceRunner = makeIverilogRunner();
