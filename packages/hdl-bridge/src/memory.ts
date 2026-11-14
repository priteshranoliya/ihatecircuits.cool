import type { MemoryCell } from '@ihatecircuits/hdl/design';
import type { Ctx } from './ctx';
import { powerOnProp } from './ctx';
import type { Src } from './gb';
import { bitDff, bitwiseRegister } from './gates';
import { LowerError } from './graph';

/**
 * Memories.
 *
 * Blocks view, in order of preference:
 *   - No write port: a ROM part per read port (a synchronous read adds a Register after it).
 *   - One write port, no initial contents, and a single asynchronous read port on the same address net: a RAM part.
 *     The part has one address pin for both, so any other shape does not fit it, and its clocked read returns
 *     the new word where the IR returns the old one.
 *   - Anything else: one register per word, a decoder per write port, and a multiplexer tree per read port.
 * Gates view: always the last form, with single-bit flip-flops and 2:1 multiplexers (a ROM is a tree over constants).
 *
 * Differences from the IR, all in places where the IR says x:
 *   - Words nothing wrote and that have no initial contents read 0 (a library register powers on at 0), where the IR reads x.
 *   - An address past the depth reads 0 or aliases to a word in the ROM and RAM parts, where the IR reads x.
 *   - A write whose address has an unknown bit poisons the words it might hit (their enable is unknown), where the IR writes
 *     nothing. Hardware cannot tell an unknown address from a known one.
 *
 * Initial contents in the register form. A word with initial contents `v` is a register whose `init` property is `v`
 * (a part's power-on value, the same mechanism as `reg q = 4'd5;`), so it powers on at `v` and the trace runner and
 * the exporter leave it there. A word with no initial contents has no `init` and starts at x in the runner.
 */

const log2ceil = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
const known = (bits: string) => BigInt('0b' + (bits.replace(/[xz]/gi, '0') || '0'));

function sharedEdge(c: MemoryCell): { clk: number; edge: 'pos' | 'neg' } {
  const first = c.writePorts[0]!;
  for (const p of c.writePorts) {
    if (p.clk !== first.clk || p.edge !== first.edge) throw new LowerError(`The memory '${c.name}' has write ports on different clocks, which the circuit cannot build yet.`);
  }
  return { clk: first.clk, edge: first.edge };
}

/** `width` bits of an address net as `k` select bits, bit 0 first: missing high bits are 0. Bits beyond `k` are returned apart. */
function addressBits(ctx: Ctx, net: number, k: number): { bits: Src[]; high: Src[] } {
  const wa = ctx.width(net);
  const all = ctx.b.fan(ctx.net(net), wa);
  const zero = wa < k ? ctx.b.konst(0) : undefined;
  return { bits: Array.from({ length: k }, (_, i) => (i < wa ? all[i]! : zero!)), high: all.slice(k) };
}

function resize(ctx: Ctx, src: Src, width: number, to: number): Src {
  if (width === to) return src;
  const part = ctx.g.add('extender', { inBits: width, outBits: to, fill: 'zero' });
  ctx.b.connect(src, { part, pin: 'in' });
  return { part, pin: 'out' };
}

function romContents(c: MemoryCell): string {
  return Array.from({ length: c.depth }, (_, a) => known(c.init?.[a] ?? '0').toString(16)).join(' ');
}

function clockRegister(ctx: Ctx, d: Src, clk: number, edge: 'pos' | 'neg', width: number): Src {
  const trigger = edge === 'pos' ? 'rising' : 'falling';
  if (ctx.view === 'gates') return bitwiseRegister(ctx.b, width, d, ctx.net(clk), trigger);
  const part = ctx.g.add('register', { bits: width, trigger });
  ctx.b.connect(d, { part, pin: 'd' });
  ctx.b.connect(ctx.net(clk), { part, pin: 'clk' });
  return { part, pin: 'q' };
}

function romPart(ctx: Ctx, c: MemoryCell, addr: number): Src {
  const k = log2ceil(c.depth);
  if (k > 16) throw new LowerError(`The memory '${c.name}' has ${c.depth} words, more than a ROM part holds.`);
  const part = ctx.g.add('rom', { addrBits: k, dataBits: c.width, contents: romContents(c) });
  ctx.b.connect(resize(ctx, ctx.net(addr), ctx.width(addr), k), { part, pin: 'a' });
  return { part, pin: 'd' };
}

function muxTree(ctx: Ctx, words: Src[], select: Src[], width: number): Src {
  let zero: Src | undefined;
  let level = words;
  for (const bit of select) {
    const next: Src[] = [];
    // Words past the depth read as 0 (the IR says x there).
    for (let i = 0; i < level.length; i += 2) next.push(ctx.b.mux(bit, level[i]!, level[i + 1] ?? (zero ??= ctx.b.konst(0, width)), width));
    level = next;
  }
  return level[0]!;
}

function generalMemory(ctx: Ctx, c: MemoryCell) {
  const { b } = ctx;
  const k = log2ceil(c.depth);
  if (k > 16) throw new LowerError(`The memory '${c.name}' has ${c.depth} words, too many to build from registers.`);
  const words: Src[] = [];

  if (c.writePorts.length === 0) {
    for (let a = 0; a < c.depth; a++) words.push(b.konstWord(known(c.init?.[a] ?? '0'), c.width));
  } else {
    const { clk, edge } = sharedEdge(c);
    const trigger = edge === 'pos' ? 'rising' : 'falling';
    // One select line per port and word: the port's enable, its address equal to the word, and its high address bits zero.
    const selects = c.writePorts.map((p) => {
      const { bits, high } = addressBits(ctx, p.addr, k);
      const inverted = bits.map((bit) => b.not(bit));
      const hiZero = high.length ? [b.tree('nor', high)] : [];
      return Array.from({ length: c.depth }, (_, a) => b.tree('and', [ctx.net(p.en), ...hiZero, ...bits.map((bit, j) => (((a >> j) & 1) === 1 ? bit : inverted[j]!))]));
    });
    for (let a = 0; a < c.depth; a++) {
      const sel = selects.map((s) => s[a]!);
      const enable = sel.length === 1 ? sel[0]! : b.tree('or', sel);
      let data: Src = ctx.net(c.writePorts[0]!.data);
      c.writePorts.slice(1).forEach((p, i) => {
        data = b.mux(sel[i + 1]!, data, ctx.net(p.data), c.width);
      });
      const start = powerOnProp(c.init?.[a]);
      const label = `${c.name}[${a}]`;
      let q: Src;
      if (ctx.view === 'blocks') {
        const part = ctx.g.add('register', { bits: c.width, trigger, ...(start ? { init: start } : {}) }, label);
        b.connect(data, { part, pin: 'd' });
        b.connect(enable, { part, pin: 'en' });
        b.connect(ctx.net(clk), { part, pin: 'clk' });
        q = { part, pin: 'q' };
      } else {
        const dBits = b.fan(data, c.width);
        const qBits = dBits.map((bit, i) => {
          const ff = bitDff(b, { trigger, clk: ctx.net(clk), label: c.width > 1 ? `${label}.${i}` : label, ...(start ? { init: start[c.width - 1 - i]! } : {}) });
          b.connect(b.mux(enable, { part: ff.part, pin: 'q' }, bit), { part: ff.part, pin: 'd' });
          return ff.q;
        });
        q = b.join(qBits);
      }
      words.push(q);
    }
  }

  for (const p of c.readPorts) {
    const value = muxTree(ctx, words, addressBits(ctx, p.addr, k).bits, c.width);
    ctx.drive(p.data, p.clk === undefined ? ctx.b.sig(value, c.width) : ctx.b.sig(clockRegister(ctx, value, p.clk, p.edge ?? 'pos', c.width), c.width));
  }
}

export function memoryCell(ctx: Ctx, c: MemoryCell): void {
  if (ctx.view === 'blocks') {
    if (c.writePorts.length === 0 && c.depth <= 1 << 16) {
      for (const p of c.readPorts) {
        const d = romPart(ctx, c, p.addr);
        ctx.drive(p.data, p.clk === undefined ? ctx.b.sig(d, c.width) : ctx.b.sig(clockRegister(ctx, d, p.clk, p.edge ?? 'pos', c.width), c.width));
      }
      return;
    }
    const w = c.writePorts[0];
    const hasInit = c.init?.length;
    if (c.writePorts.length === 1 && w && !hasInit && ctx.width(w.addr) <= 16 && c.readPorts.length <= 1 && c.readPorts.every((r) => r.clk === undefined && r.addr === w.addr)) {
      const part = ctx.g.add('ram', { addrBits: ctx.width(w.addr), dataBits: c.width, bus: 'separate', asyncRead: true, trigger: w.edge === 'pos' ? 'rising' : 'falling' }, c.name);
      ctx.b.connect(ctx.net(w.addr), { part, pin: 'a' });
      ctx.b.connect(ctx.net(w.data), { part, pin: 'din' });
      ctx.b.connect(ctx.net(w.en), { part, pin: 'we' });
      ctx.b.connect(ctx.net(w.clk), { part, pin: 'clk' });
      for (const r of c.readPorts) ctx.drive(r.data, { part, pin: 'dout' });
      return;
    }
  }
  generalMemory(ctx, c);
}
