/**
 * The elaborated design: a word-level, language-neutral netlist.
 *
 * Nothing in here refers to Verilog. A front end for another language could
 * produce the same structure, and a back end only needs this file.
 *
 * Model
 *   A Design is a set of Modules, ordered so that every module comes after the
 *   modules it instantiates; `top` names the root. A Module has
 *   - nets: named or anonymous bit vectors (1..32 bits, bit 0 least significant);
 *   - ports: the module's interface, each bound to one net;
 *   - cells: word-level operators and registers, each driving its output net(s).
 *
 * Rules every Module satisfies
 *   - A net is driven by at most one source: an input port, one cell output, or
 *     nothing. A net with no source is undriven and reads as unknown ('z').
 *     This is checked on the final nets, after names are aliased together, so it
 *     does not depend on the order of the statements that drove them.
 *   - Several names can denote the same net (`assign y = x;` makes y and x one
 *     net), so `Net.names` is a list and two ports may share a net.
 *   - Operand widths are explicit: every cell's input nets already have the
 *     widths its operator needs. Zero-extension and truncation appear as
 *     `concat` and `slice` cells; the language's width rules are applied during
 *     elaboration, not left for the consumer.
 *   - Combinational cells may form loops (a Verilog program may describe one);
 *     only `dff` breaks a loop in time.
 *   - Cells are listed in creation order. The order is deterministic.
 *
 * Value semantics (what a consumer must implement)
 *   Values are four-state per bit: 0, 1, x (unknown) and z (high impedance).
 *   A cell reads z as x. Every operator below is evaluated per its Verilog
 *   definition on 0/1 inputs; on unknown inputs it follows the Verilog tables
 *   (e.g. `and` of 0 and x is 0), except where a cell says otherwise.
 *
 * Where hardware and a Verilog simulator differ
 *   The design describes hardware. A Verilog simulator adds rules that hardware
 *   does not have. These are known differences, kept on purpose and taught
 *   rather than faked; the compiler warns where it can tell one is in play.
 *   - `if (c)` with an unknown `c`. Verilog takes the else branch; a mux (this
 *     IR, and the circuit built from it, as in synthesis) merges both branches
 *     bit by bit, and real hardware could go either way. They agree once `c` is
 *     known. `c` is unknown until it is first written, so a reg that never gets
 *     a reset assignment feeding an `if` condition (directly or through
 *     combinational logic) is reported as `if-unknown-condition`. The `?:`
 *     operator does merge in Verilog, so it carries no warning.
 *   - Power-on. A Verilog reg starts as x and is x until written. An undriven
 *     wire reads z, and every cell reads z as x. A reg that is never assigned
 *     therefore reads x in Verilog but is an undriven (floating) net here, which
 *     reads z at an output: the `undriven` warning says so. A z loaded into a reg
 *     becomes x, where a Verilog reg would keep the z.
 *   - Clock edges. A Verilog simulator counts x to 1 as a rising edge. A `dff`
 *     does not: it ignores its clock until the clock has had a known level, so a
 *     clock that starts unknown does not fire a spurious edge.
 *   - Derived clocks. Verilog updates registers (nonblocking assignments) only
 *     after every clock has fired, so a register clocked through `clk & en` still
 *     sees the data from before the edge. A circuit has gate delays, so lowering
 *     slows every register by more than the deepest clock path. Clocks that pass
 *     through logic are reported as `gated-clock`: in hardware they cause skew.
 */

export type NetId = number;

export interface Net {
  id: NetId;
  /** 1..32. */
  width: number;
  /** Source-level names for this net, in declaration order. Empty for compiler temporaries. */
  names: string[];
  /**
   * How several drivers combine (default 'wire'). Only a net whose drivers are all `tribuf`
   * cells (plus at most one other driver) may have more than one driver.
   * - 'wire': z yields to any value; two different driven values give x.
   * - 'wand' / 'wor': driven values combine by AND / OR.
   * - 'pull0' / 'pull1': as 'wire', but an all-z bit reads 0 / 1 (tri0, tri1, pulldown, pullup).
   * - 'supply0' / 'supply1': constant 0 / 1 net.
   */
  kind?: 'wire' | 'wand' | 'wor' | 'pull0' | 'pull1' | 'supply0' | 'supply1';
}

export interface Port {
  name: string;
  dir: 'in' | 'out';
  width: number;
  net: NetId;
}

/** A literal. `bits` is most significant bit first, over '0' '1' 'x' 'z'; its length is the net's width. */
export interface ConstCell {
  kind: 'const';
  out: NetId;
  bits: string;
}

/** Bitwise complement. `a` and `out` have the same width. */
export interface NotCell {
  kind: 'not';
  a: NetId;
  out: NetId;
}

/** Bitwise two-input operator. `a`, `b` and `out` all have the same width. xnor is ~(a ^ b). */
export interface BitwiseCell {
  kind: 'and' | 'or' | 'xor' | 'xnor';
  a: NetId;
  b: NetId;
  out: NetId;
}

/** Unsigned `a + b` modulo 2^width. `a`, `b` and `out` have the same width: the carry is never part of the result. */
export interface AddCell {
  kind: 'add';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * Logical equality (`eq`) or inequality (`ne`); `out` is 1 bit. Operands have the same width.
 * With unknown bits: a known difference decides the result; otherwise unknown bits make it x.
 */
export interface CompareCell {
  kind: 'eq' | 'ne';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * `sel ? onTrue : onFalse`. `sel` is 1 bit; the data nets and `out` have the same width.
 * An unknown `sel` gives the bitwise merge: a bit keeps its value where both data bits agree, else x.
 */
export interface MuxCell {
  kind: 'mux';
  sel: NetId;
  onFalse: NetId;
  onTrue: NetId;
  out: NetId;
}

/** Concatenation; `parts[0]` becomes the most significant bits. `out` width is the sum of the part widths. */
export interface ConcatCell {
  kind: 'concat';
  parts: NetId[];
  out: NetId;
}

/** `a[lsb + width - 1 : lsb]` where `width` is the width of `out`. */
export interface SliceCell {
  kind: 'slice';
  a: NetId;
  lsb: number;
  out: NetId;
}

/**
 * Edge-triggered register. On the `edge` of `clk` it loads `d` into `q`; otherwise it holds.
 * `q` is the only net a register drives, and `d` and `q` have the same width.
 * `clk` is 1 bit. Before the first edge `q` is unknown (x), as a Verilog reg is.
 */
export interface DffCell {
  kind: 'dff';
  clk: NetId;
  edge: 'pos' | 'neg';
  d: NetId;
  q: NetId;
}

/**
 * An instance of another module of the design. `inputs` and `outputs` map the callee's port
 * names to nets in this module; ports that are left unconnected are absent.
 */
export interface InstanceCell {
  kind: 'instance';
  module: string;
  name: string;
  inputs: Record<string, NetId>;
  outputs: Record<string, NetId>;
}

/** `a - b` modulo 2^width (two's complement, so it serves signed and unsigned alike). Same widths. */
export interface SubCell {
  kind: 'sub';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * `a * b`, the low `width` bits. Same widths. The low half of a product is the same for signed and
 * unsigned operands once they are extended to the result width, so one cell serves both.
 * Any unknown input bit makes every output bit x.
 */
export interface MulCell {
  kind: 'mul';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * Division and remainder. Same widths. `divs`/`rems` treat operands as two's complement:
 * the quotient truncates toward zero and the remainder takes the sign of the dividend.
 * Division by zero, or any unknown input bit, makes every output bit x.
 */
export interface DivCell {
  kind: 'divu' | 'remu' | 'divs' | 'rems';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * Shifts. `a` and `out` have the same width; `amount` is unsigned and may be any width (1..32).
 * `shl`/`shr` fill with 0; `sshr` fills with the sign bit of `a`. A shift by `width` or more gives
 * all fill bits. Any unknown bit in `amount` makes every output bit x.
 */
export interface ShiftCell {
  kind: 'shl' | 'shr' | 'sshr';
  a: NetId;
  amount: NetId;
  out: NetId;
}

/**
 * Less-than, unsigned (`ltu`) or two's complement (`lts`). `out` is 1 bit; operands have the same width.
 * Any unknown input bit makes the result x. (Other orderings are built from these and `not`.)
 */
export interface LessCell {
  kind: 'ltu' | 'lts';
  a: NetId;
  b: NetId;
  out: NetId;
}

/**
 * Reduction of every bit of `a` to one bit (`&a`, `|a`, `^a`). `out` is 1 bit.
 * Follows the Verilog tables: `|` with any 1 is 1, `&` with any 0 is 0, otherwise unknown bits give x.
 */
export interface ReduceCell {
  kind: 'reduce_and' | 'reduce_or' | 'reduce_xor';
  a: NetId;
  out: NetId;
}

/**
 * Register with an asynchronous reset or set. While `arst` is at its active level (`arstLevel`),
 * `q` is forced to `arstValue` (MSB first, over '0' '1', length = width); otherwise it behaves as a
 * `dff`. An unknown `arst` makes the bits where `arstValue` and the would-be value differ x.
 */
export interface AdffCell {
  kind: 'adff';
  clk: NetId;
  edge: 'pos' | 'neg';
  arst: NetId;
  arstLevel: 0 | 1;
  arstValue: string;
  d: NetId;
  q: NetId;
}

/**
 * Level-sensitive latch: while `en` is at `enLevel`, `q` follows `d`; otherwise it holds.
 * Usually inferred from incomplete combinational assignments (the compiler warns `latch-inferred`).
 */
export interface LatchCell {
  kind: 'latch';
  en: NetId;
  enLevel: 0 | 1;
  d: NetId;
  q: NetId;
}

/**
 * Tri-state buffer: drives `a` onto `out` while `en` is 1, and z while `en` is 0; an unknown `en`
 * drives x where `a` is not z. Several tri-state buffers (and at most one other driver) may share
 * an output net; the net resolves their values (see `Net.kind`).
 */
export interface TribufCell {
  kind: 'tribuf';
  a: NetId;
  en: NetId;
  out: NetId;
}

/**
 * A memory (`reg [W-1:0] mem [0:D-1]`): `depth` words of the net width of its data ports.
 * Read ports are asynchronous (`clk` absent) or synchronous (registered on `edge` of `clk`).
 * Write ports write `data` to word `addr` on `edge` of `clk` while `en` is 1. An address outside
 * 0..depth-1, or with unknown bits, reads x and writes nothing. Words start as x unless `init`
 * gives them (MSB-first bit strings, index = word address). When a read and a write on the same
 * edge hit the same word, a synchronous read returns the OLD word (Verilog nonblocking semantics).
 */
export interface MemoryCell {
  kind: 'memory';
  name: string;
  width: number;
  depth: number;
  init?: string[];
  readPorts: { addr: NetId; data: NetId; clk?: NetId; edge?: 'pos' | 'neg' }[];
  writePorts: { addr: NetId; data: NetId; en: NetId; clk: NetId; edge: 'pos' | 'neg' }[];
}

export type Cell =
  | ConstCell
  | NotCell
  | BitwiseCell
  | AddCell
  | SubCell
  | MulCell
  | DivCell
  | ShiftCell
  | CompareCell
  | LessCell
  | ReduceCell
  | MuxCell
  | ConcatCell
  | SliceCell
  | DffCell
  | AdffCell
  | LatchCell
  | TribufCell
  | MemoryCell
  | InstanceCell;

export interface Module {
  name: string;
  ports: Port[];
  nets: Net[];
  cells: Cell[];
}

export interface Design {
  modules: Module[];
  /** Name of the root module. */
  top: string;
}

/** The nets a cell reads. */
export function cellInputs(c: Cell): NetId[] {
  switch (c.kind) {
    case 'const':
      return [];
    case 'not':
    case 'slice':
      return [c.a];
    case 'reduce_and':
    case 'reduce_or':
    case 'reduce_xor':
      return [c.a];
    case 'and':
    case 'or':
    case 'xor':
    case 'xnor':
    case 'add':
    case 'sub':
    case 'mul':
    case 'divu':
    case 'remu':
    case 'divs':
    case 'rems':
    case 'eq':
    case 'ne':
    case 'ltu':
    case 'lts':
      return [c.a, c.b];
    case 'shl':
    case 'shr':
    case 'sshr':
      return [c.a, c.amount];
    case 'mux':
      return [c.sel, c.onFalse, c.onTrue];
    case 'concat':
      return [...c.parts];
    case 'dff':
      return [c.clk, c.d];
    case 'adff':
      return [c.clk, c.arst, c.d];
    case 'latch':
      return [c.en, c.d];
    case 'tribuf':
      return [c.a, c.en];
    case 'memory':
      return [
        ...c.readPorts.flatMap((p) => (p.clk === undefined ? [p.addr] : [p.addr, p.clk])),
        ...c.writePorts.flatMap((p) => [p.addr, p.data, p.en, p.clk]),
      ];
    case 'instance':
      return Object.values(c.inputs);
  }
}

/** The nets a cell drives. */
export function cellOutputs(c: Cell): NetId[] {
  switch (c.kind) {
    case 'dff':
    case 'adff':
    case 'latch':
      return [c.q];
    case 'memory':
      return c.readPorts.map((p) => p.data);
    case 'instance':
      return Object.values(c.outputs);
    default:
      return [c.out];
  }
}

/** Cells whose output holds state across time (they break combinational loops). */
export function isStateful(c: Cell): boolean {
  return c.kind === 'dff' || c.kind === 'adff' || c.kind === 'latch' || c.kind === 'memory';
}

export function findModule(d: Design, name: string): Module | undefined {
  return d.modules.find((m) => m.name === name);
}
