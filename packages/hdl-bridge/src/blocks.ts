import type { Cell, NetId } from '@ihatecircuits/hdl';
import type { Ctx } from './ctx';
import type { Src } from './gb';

/**
 * The blocks view of the arithmetic cells: one library part each, with guard logic around the part where
 * the part's edge cases differ from the IR.
 *
 *   sub        Subtractor (borrow-in left at 0)
 *   mul        Multiplier, low half P (the low half of a product is the same for signed and unsigned operands)
 *   divu remu  Divider, Q or R
 *   divs rems  Negators and multiplexers take the magnitudes and fix the signs around an unsigned Divider
 *   shl shr sshr  Shifter in SLL, SRL or SRA mode; see `shifter` for the amount guard
 *   ltu lts    Comparator, `<` output
 *
 * Unknown inputs. Where the IR says every output bit is x the part may answer anything on 0/1 inputs only,
 * so the guard logic does not try to produce x. Division by zero is the one visible case: the IR gives x, the
 * Divider gives the RISC-V answer (quotient all ones, remainder the dividend), and the signed variants give
 * whatever the sign fix-up makes of that. Hardware having no x to give, a defined value is the honest result.
 */

const indexBits = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/** Bus `net` of `width` bits, narrowed or zero-extended to `to` bits. */
function resize(ctx: Ctx, src: Src, width: number, to: number): Src {
  if (width === to) return src;
  const part = ctx.g.add('extender', { inBits: width, outBits: to, fill: 'zero' });
  ctx.b.connect(src, { part, pin: 'in' });
  return { part, pin: 'out' };
}

/** The sign bit of a bus, as a one-bit source. */
function signBit(ctx: Ctx, src: Src, width: number): Src {
  return ctx.b.fan(src, width)[width - 1]!;
}

function negated(ctx: Ctx, src: Src, width: number): Src {
  const part = ctx.g.add('negator', { bits: width });
  ctx.b.connect(src, { part, pin: 'a' });
  return { part, pin: 'y' };
}

/** `sign ? -x : x`, taking the magnitude (or restoring the sign) of a two's complement value. */
function absOrNegate(ctx: Ctx, x: Src, sign: Src, width: number): Src {
  return ctx.b.mux(sign, x, negated(ctx, x, width), width);
}

function divider(ctx: Ctx, a: Src, b: Src, width: number): { q: Src; r: Src } {
  const part = ctx.g.add('divider', { bits: width });
  ctx.b.connect(a, { part, pin: 'a' });
  ctx.b.connect(b, { part, pin: 'b' });
  return { q: { part, pin: 'q' }, r: { part, pin: 'r' } };
}

function shifter(ctx: Ctx, cell: Extract<Cell, { kind: 'shl' | 'shr' | 'sshr' }>): Src {
  const { b } = ctx;
  const w = ctx.width(cell.a);
  const wa = ctx.width(cell.amount);
  const ib = indexBits(w);
  const mode = cell.kind === 'shl' ? 'sll' : cell.kind === 'shr' ? 'srl' : 'sra';
  const part = ctx.g.add('shifter', { bits: w, mode });
  b.connect(ctx.net(cell.a), { part, pin: 'a' });
  const out: Src = { part, pin: 'y' };
  if (wa <= ib) {
    // Amounts the pin can count to but that are not below the width are handled by the Shifter itself (it empties or fills).
    b.connect(resize(ctx, ctx.net(cell.amount), wa, ib), { part, pin: 'n' });
    return out;
  }
  // The Shifter's amount pin has only `ib` bits. An amount with any higher bit set is at least 2^ib, hence at least the width.
  const sp = ctx.g.add('splitter', { width: wa, fans: 2, map: Array.from({ length: wa }, (_, i) => (i < ib ? 0 : 1)).join(' ') });
  b.connect(ctx.net(cell.amount), { part: sp, pin: 'c' });
  b.connect({ part: sp, pin: 'f0' }, { part, pin: 'n' });
  const big = b.tree('or', b.fan({ part: sp, pin: 'f1' }, wa - ib));
  const fill: Src = cell.kind === 'sshr' ? signFill(ctx, cell.a, w) : b.konst(0, w);
  return b.mux(big, out, fill, w);
}

/** A bus of `width` copies of the sign bit of `net`. */
function signFill(ctx: Ctx, net: NetId, width: number): Src {
  const part = ctx.g.add('extender', { inBits: 1, outBits: width, fill: 'sign' });
  ctx.b.connect(signBit(ctx, ctx.net(net), width), { part, pin: 'in' });
  return { part, pin: 'out' };
}

export function blocksCell(ctx: Ctx, cell: Cell): boolean {
  const { b, g } = ctx;
  const w = (n: NetId) => ctx.width(n);
  const net = ctx.net;
  switch (cell.kind) {
    case 'sub': {
      const part = g.add('subtractor', { bits: w(cell.out) });
      b.connect(net(cell.a), { part, pin: 'a' });
      b.connect(net(cell.b), { part, pin: 'b' });
      ctx.drive(cell.out, { part, pin: 'd' });
      return true;
    }
    case 'mul': {
      const part = g.add('multiplier', { bits: w(cell.out) });
      b.connect(net(cell.a), { part, pin: 'a' });
      b.connect(net(cell.b), { part, pin: 'b' });
      ctx.drive(cell.out, { part, pin: 'p' });
      return true;
    }
    case 'divu':
    case 'remu': {
      const d = divider(ctx, net(cell.a), net(cell.b), w(cell.out));
      ctx.drive(cell.out, b.sig(cell.kind === 'divu' ? d.q : d.r));
      return true;
    }
    case 'divs':
    case 'rems': {
      const n = w(cell.out);
      const sa = signBit(ctx, net(cell.a), n);
      const sb = signBit(ctx, net(cell.b), n);
      const d = divider(ctx, absOrNegate(ctx, net(cell.a), sa, n), absOrNegate(ctx, net(cell.b), sb, n), n);
      const out = cell.kind === 'divs' ? absOrNegate(ctx, d.q, b.xor(sa, sb), n) : absOrNegate(ctx, d.r, sa, n);
      ctx.drive(cell.out, b.sig(out, n));
      return true;
    }
    case 'ltu':
    case 'lts': {
      const part = g.add('comparator', { bits: w(cell.a), numeric: cell.kind === 'lts' ? 'signed' : 'unsigned' });
      b.connect(net(cell.a), { part, pin: 'a' });
      b.connect(net(cell.b), { part, pin: 'b' });
      ctx.drive(cell.out, { part, pin: 'lt' });
      return true;
    }
    case 'shl':
    case 'shr':
    case 'sshr':
      ctx.drive(cell.out, b.sig(shifter(ctx, cell), w(cell.out)));
      return true;
    default:
      return false;
  }
}
