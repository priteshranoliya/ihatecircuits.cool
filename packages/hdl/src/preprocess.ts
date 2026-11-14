import { type DiagnosticSink, type Expansion, SourceMap, type Span } from './diagnostics';

/**
 * Preprocessor (IEEE 1364-2005 clause 19, "compiler directives").
 *
 * It rewrites source text before the lexer sees it: macros are expanded, conditional regions are kept or
 * dropped, `include files are spliced in, and the directives that carry no text (`timescale and the like) are
 * recorded and removed. Comments and strings pass through untouched, so a directive written inside either is
 * not a directive.
 *
 * Every piece of the output remembers where it came from (file, offset, and the macro expansions it sits
 * inside), and `PreprocessedMap.span` turns an offset in the output back into the original file, line and
 * column. A token that came from a macro body points at the body in the `define, and says which macro it
 * was and where that macro was used.
 */

export interface PreprocessOptions {
  /** Name of the main text, used in `__FILE__` and in spans of the other files. */
  fileName?: string;
  /** Virtual file system for `include: path to text. */
  files?: Record<string, string>;
  /** Macros defined before the first line, as if by `define NAME value. */
  defines?: Record<string, string>;
}

export interface Directive {
  name: string;
  /** The rest of the directive's line, trimmed. */
  args: string;
  span: Span;
}

export interface PreprocessResult {
  text: string;
  map: SourceMap;
  /** `timescale, `default_nettype, `celldefine, ... in the order met. */
  directives: Directive[];
}

const MAX_INCLUDE_DEPTH = 64;
const MAX_EXPANSION_DEPTH = 100;
const MAX_EXPANDED = 500_000;
const NET_TYPES = new Set(['wire', 'tri', 'tri0', 'tri1', 'wand', 'triand', 'wor', 'trior', 'trireg', 'uwire', 'none']);
const TIMESCALE = /^(1|10|100)\s*(s|ms|us|ns|ps|fs)\s*\/\s*(1|10|100)\s*(s|ms|us|ns|ps|fs)$/;
const NO_ARG_DIRECTIVES = new Set(['resetall', 'celldefine', 'endcelldefine', 'nounconnected_drive', 'end_keywords', 'undefineall']);

// ---------------------------------------------------------------- source tracking

class FileEntry {
  private map: SourceMap | undefined;
  private physLineAtDir = new Map<LineDirective, number>();
  readonly lineDirs: LineDirective[] = [];
  constructor(
    readonly name: string,
    readonly text: string,
    readonly isMain: boolean,
  ) {}

  private sourceMap(): SourceMap {
    return (this.map ??= new SourceMap(this.text));
  }

  /** Line and column of `offset`, after any `line directives above it. */
  position(offset: number): { line: number; col: number; file: string } {
    const phys = this.sourceMap().span(offset, offset);
    let dir: LineDirective | undefined;
    for (const d of this.lineDirs) if (d.offset <= offset) dir = d;
    if (!dir) return { line: phys.line, col: phys.col, file: this.name };
    let base = this.physLineAtDir.get(dir);
    if (base === undefined) {
      base = this.sourceMap().span(dir.offset, dir.offset).line;
      this.physLineAtDir.set(dir, base);
    }
    return { line: dir.line + (phys.line - base), col: phys.col, file: dir.file };
  }
}

interface LineDirective {
  /** Offset of the first character of the line that follows the directive. */
  offset: number;
  line: number;
  file: string;
}

/** A position in some file, and the macro expansion it is inside of. */
interface Origin {
  file: FileEntry;
  offset: number;
  exp?: Frame;
}

/** One macro expansion: the macro, and the place it was used. */
interface Frame {
  macro: string;
  use: Origin;
}

interface Chunk {
  text: string;
  origin: Origin;
}

function frameToExpansion(f: Frame | undefined): Expansion | undefined {
  if (!f) return undefined;
  const at = f.use.file.position(f.use.offset);
  const e: Expansion = { macro: f.macro, line: at.line, col: at.col };
  if (!f.use.file.isMain || at.file !== f.use.file.name) e.file = at.file;
  const outer = frameToExpansion(f.use.exp);
  if (outer) e.outer = outer;
  return e;
}

function originSpan(o: Origin, start: number, end: number): Span {
  const at = o.file.position(o.offset);
  const s: Span = { start, end, line: at.line, col: at.col };
  if (!o.file.isMain || at.file !== o.file.name) s.file = at.file;
  const exp = frameToExpansion(o.exp);
  if (exp) s.expansion = exp;
  return s;
}

/** Maps offsets in the preprocessed text back to the files they came from. */
export class PreprocessedMap extends SourceMap {
  private readonly starts: number[] = [];
  private readonly origins: Origin[] = [];

  constructor(text: string, chunks: Chunk[]) {
    super(text);
    let at = 0;
    for (const c of chunks) {
      this.starts.push(at);
      this.origins.push(c.origin);
      at += c.text.length;
    }
  }

  override span(start: number, end: number): Span {
    if (this.starts.length === 0) return super.span(start, end);
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= start) lo = mid;
      else hi = mid - 1;
    }
    const o = this.origins[lo]!;
    return originSpan({ file: o.file, offset: o.offset + (start - this.starts[lo]!), exp: o.exp }, start, end);
  }
}

// ---------------------------------------------------------------- scan sources

/** Text being scanned, with a way back to where each character came from. */
interface Src {
  readonly text: string;
  originAt(pos: number): Origin;
  slice(a: number, b: number): Chunk[];
}

class FileSrc implements Src {
  constructor(
    readonly file: FileEntry,
    readonly text: string = file.text,
  ) {}
  originAt(pos: number): Origin {
    return { file: this.file, offset: pos };
  }
  slice(a: number, b: number): Chunk[] {
    return a < b ? [{ text: this.text.slice(a, b), origin: { file: this.file, offset: a } }] : [];
  }
}

class ChunkSrc implements Src {
  readonly text: string;
  private readonly starts: number[] = [];
  constructor(private readonly chunks: Chunk[]) {
    let at = 0;
    for (const c of chunks) {
      this.starts.push(at);
      at += c.text.length;
    }
    this.text = chunks.map((c) => c.text).join('');
  }
  private index(pos: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  originAt(pos: number): Origin {
    if (this.chunks.length === 0) throw new Error('empty source has no origin');
    const i = this.index(pos);
    const o = this.chunks[i]!.origin;
    return { file: o.file, offset: o.offset + (pos - this.starts[i]!), exp: o.exp };
  }
  slice(a: number, b: number): Chunk[] {
    const out: Chunk[] = [];
    if (a >= b || this.chunks.length === 0) return out;
    for (let i = this.index(a); i < this.chunks.length && this.starts[i]! < b; i++) {
      const c = this.chunks[i]!;
      const from = Math.max(a, this.starts[i]!) - this.starts[i]!;
      const to = Math.min(b, this.starts[i]! + c.text.length) - this.starts[i]!;
      if (from < to) out.push({ text: c.text.slice(from, to), origin: { file: c.origin.file, offset: c.origin.offset + from, exp: c.origin.exp } });
    }
    return out;
  }
}

class Out {
  readonly chunks: Chunk[] = [];
  length = 0;
  add(c: Chunk) {
    if (c.text === '') return;
    const prev = this.chunks[this.chunks.length - 1];
    if (prev && prev.origin.file === c.origin.file && prev.origin.exp === c.origin.exp && prev.origin.offset + prev.text.length === c.origin.offset) {
      prev.text += c.text;
    } else this.chunks.push({ text: c.text, origin: c.origin });
    this.length += c.text.length;
  }
}

// ---------------------------------------------------------------- macros

type Part = { kind: 'text'; file: FileEntry; start: number; end: number } | { kind: 'arg'; index: number };

interface Formal {
  name: string;
  /** Text of the default value. */
  def?: { file: FileEntry; start: number; end: number };
}

interface Macro {
  name: string;
  formals: Formal[] | undefined;
  parts: Part[];
}

interface Cond {
  /** Text in this region is kept. */
  active: boolean;
  /** Some branch of this conditional was already taken (or the whole conditional is inside a dropped region). */
  taken: boolean;
  sawElse: boolean;
  origin: Origin;
  name: string;
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t';
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
const isNewline = (c: string | undefined) => c === '\n' || c === '\r';
const IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/');
}

class Preprocessor {
  private readonly macros = new Map<string, Macro>();
  private readonly out = new Out();
  private readonly directives: Directive[] = [];
  private readonly expanding: string[] = [];
  private readonly includeStack: string[] = [];
  private readonly files = new Map<string, FileEntry>();
  private mainFile!: FileEntry;
  private overflowed = false;
  private expanded = 0;

  constructor(
    private readonly sink: DiagnosticSink,
    private readonly opts: PreprocessOptions,
  ) {}

  run(source: string): PreprocessResult {
    const name = this.opts.fileName ?? 'input.v';
    this.mainFile = new FileEntry(name, source, true);
    for (const [k, v] of Object.entries(this.opts.defines ?? {})) {
      const f = new FileEntry('<command line>', v, false);
      this.macros.set(k, { name: k, formals: undefined, parts: [{ kind: 'text', file: f, start: 0, end: v.length }] });
    }
    this.includeStack.push(name);
    this.scan(new FileSrc(this.mainFile), this.out, 0);
    const text = this.out.chunks.map((c) => c.text).join('');
    return { text, map: new PreprocessedMap(text, this.out.chunks), directives: this.directives };
  }

  // ------------------------------------------------------------ diagnostics

  private error(o: Origin, message: string, out: Out) {
    this.sink.error('preprocess-error', message, originSpan(o, out.length, out.length));
  }

  // ------------------------------------------------------------ scanning

  private scan(src: Src, out: Out, depth: number) {
    const text = src.text;
    const n = text.length;
    const cond: Cond[] = [];
    const active = () => cond.length === 0 || cond[cond.length - 1]!.active;
    const emit = (a: number, b: number) => {
      if (a >= b || !active() || this.overflowed) return;
      for (const c of src.slice(a, b)) out.add(c);
      if (depth > 0) this.expanded += b - a;
      if (this.expanded > MAX_EXPANDED) {
        this.overflowed = true;
        this.error(src.originAt(Math.min(a, n - 1)), `Macros expand to more than ${MAX_EXPANDED} characters. A macro probably expands into itself many times over.`, out);
      }
    };
    const INTERESTING = /[`"/\\]/g;
    let i = 0;
    while (i < n && !this.overflowed) {
      INTERESTING.lastIndex = i;
      const m = INTERESTING.exec(text);
      const j = m ? m.index : n;
      emit(i, j);
      if (!m) break;
      i = j;
      const c = text[i]!;
      if (c === '/') {
        if (text[i + 1] === '/') {
          let end = i;
          while (end < n && !isNewline(text[end])) end++;
          emit(i, end);
          i = end;
        } else if (text[i + 1] === '*') {
          const close = text.indexOf('*/', i + 2);
          const end = close < 0 ? n : close + 2;
          emit(i, end);
          i = end;
        } else {
          emit(i, i + 1);
          i++;
        }
        continue;
      }
      if (c === '"') {
        let p = i + 1;
        while (p < n && text[p] !== '"' && !isNewline(text[p])) p += text[p] === '\\' ? 2 : 1;
        const end = text[p] === '"' ? p + 1 : Math.min(p, n);
        emit(i, end);
        i = end;
        continue;
      }
      if (c === '\\') {
        let p = i + 1;
        while (p < n && !isSpace(text[p])) p++;
        emit(i, p);
        i = p;
        continue;
      }
      i = this.directive(src, i, out, depth, cond, active);
    }
    for (const c of cond) this.error(c.origin, `This \`${c.name} is never closed. Add \`endif.`, out);
  }

  /** Handle the directive or macro use whose backtick is at `i`. Returns where scanning resumes. */
  private directive(src: Src, i: number, out: Out, depth: number, cond: Cond[], active: () => boolean): number {
    const text = src.text;
    const n = text.length;
    IDENT.lastIndex = i + 1;
    const m = IDENT.exec(text);
    const here = src.originAt(i);
    if (!m) {
      if (active()) this.error(here, "A '`' must be followed by a directive or macro name.", out);
      return i + 1;
    }
    const name = m[0];
    let p = i + 1 + name.length;

    /** The rest of the line after the directive, and where the line ends. */
    const restOfLine = (): { args: string; end: number } => {
      let end = p;
      while (end < n && !isNewline(text[end])) end++;
      let args = text.slice(p, end);
      const cmt = args.indexOf('//');
      if (cmt >= 0) args = args.slice(0, cmt);
      return { args: args.trim(), end };
    };
    const record = (args: string) => this.directives.push({ name, args, span: originSpan(here, out.length, out.length) });

    switch (name) {
      case 'ifdef':
      case 'ifndef':
      case 'elsif': {
        while (isBlank(text[p])) p++;
        IDENT.lastIndex = p;
        const id = IDENT.exec(text);
        if (!id) {
          if (active() || name === 'elsif') this.error(here, `\`${name} needs a macro name.`, out);
          return p;
        }
        p += id[0].length;
        const defined = this.macros.has(id[0]);
        if (name === 'elsif') {
          const top = cond[cond.length - 1];
          if (!top) {
            this.error(here, '`elsif without a matching `ifdef or `ifndef.', out);
          } else if (top.sawElse) this.error(here, '`elsif after `else.', out);
          else {
            const outer = cond.length === 1 || cond[cond.length - 2]!.active;
            top.active = outer && !top.taken && defined;
            top.taken = top.taken || top.active;
          }
        } else {
          const outer = active();
          const take = outer && (name === 'ifdef' ? defined : !defined);
          cond.push({ active: take, taken: take || !outer, sawElse: false, origin: here, name });
        }
        return p;
      }
      case 'else': {
        const top = cond[cond.length - 1];
        if (!top) this.error(here, '`else without a matching `ifdef or `ifndef.', out);
        else if (top.sawElse) this.error(here, 'This conditional already has an `else.', out);
        else {
          const outer = cond.length === 1 || cond[cond.length - 2]!.active;
          top.sawElse = true;
          top.active = outer && !top.taken;
          top.taken = true;
        }
        return p;
      }
      case 'endif':
        if (!cond.pop()) this.error(here, '`endif without a matching `ifdef or `ifndef.', out);
        return p;
      default:
    }

    // Everything else is ignored in a dropped region, without looking at its arguments.
    if (!active()) return p;

    switch (name) {
      case 'define':
        return this.define(src, p, here, out);
      case 'undef': {
        while (isBlank(text[p])) p++;
        IDENT.lastIndex = p;
        const id = IDENT.exec(text);
        if (!id) this.error(here, '`undef needs a macro name.', out);
        else {
          this.macros.delete(id[0]);
          p += id[0].length;
        }
        return p;
      }
      case 'include': {
        while (isBlank(text[p])) p++;
        const open = text[p];
        const closeCh = open === '"' ? '"' : open === '<' ? '>' : '';
        const end = closeCh ? text.indexOf(closeCh, p + 1) : -1;
        const eol = (() => {
          let e = p;
          while (e < n && !isNewline(text[e])) e++;
          return e;
        })();
        if (!closeCh || end < 0 || end > eol) {
          this.error(here, '`include needs a file name in quotes, as in `include "defs.v".', out);
          return eol;
        }
        this.include(text.slice(p + 1, end), here, out, depth);
        return end + 1;
      }
      case 'timescale': {
        const { args, end } = restOfLine();
        if (!TIMESCALE.test(args)) this.error(here, `\`timescale needs a unit and a precision such as "1ns / 1ps", not "${args}".`, out);
        record(args);
        return end;
      }
      case 'default_nettype': {
        const { args, end } = restOfLine();
        if (!NET_TYPES.has(args)) this.error(here, `\`default_nettype needs a net type such as wire, or none, not "${args}".`, out);
        record(args);
        return end;
      }
      case 'line': {
        const { args, end } = restOfLine();
        const lm = /^(\d+)\s+"([^"]*)"\s+([012])$/.exec(args);
        if (!lm) this.error(here, `\`line needs a number, a file name in quotes and a level, as in \`line 10 "a.v" 0, not "${args}".`, out);
        else if (here.file) {
          let nextLine = end;
          if (text[nextLine] === '\r' && text[nextLine + 1] === '\n') nextLine += 2;
          else if (nextLine < n) nextLine += 1;
          if (src instanceof FileSrc) here.file.lineDirs.push({ offset: nextLine, line: Number(lm[1]), file: lm[2]! });
        }
        record(args);
        return end;
      }
      case 'pragma':
      case 'begin_keywords':
      case 'unconnected_drive': {
        const { args, end } = restOfLine();
        record(args);
        return end;
      }
      case '__FILE__': {
        const at = here.file.position(here.offset);
        out.add({ text: `"${at.file}"`, origin: here });
        return p;
      }
      case '__LINE__': {
        const at = here.file.position(here.offset);
        out.add({ text: String(at.line), origin: here });
        return p;
      }
      default:
    }
    if (NO_ARG_DIRECTIVES.has(name)) {
      if (name === 'undefineall') this.macros.clear();
      record('');
      return p;
    }
    return this.use(src, name, p, here, out, depth);
  }

  // ------------------------------------------------------------ define

  private define(src: Src, from: number, here: Origin, out: Out): number {
    const text = src.text;
    const n = text.length;
    let p = from;
    while (isBlank(text[p])) p++;
    IDENT.lastIndex = p;
    const id = IDENT.exec(text);
    if (!id) {
      this.error(here, '`define needs a macro name.', out);
      let e = p;
      while (e < n && !isNewline(text[e])) e++;
      return e;
    }
    const name = id[0];
    p += name.length;
    const file = here.file;
    const base = (pos: number) => src.originAt(pos).offset;
    if (!(src instanceof FileSrc)) {
      this.error(here, '`define inside a macro expansion is not supported.', out);
      return p;
    }
    let formals: Formal[] | undefined;
    if (text[p] === '(') {
      formals = [];
      p++;
      let depth = 0;
      let start = p;
      const flush = (end: number) => {
        const raw = text.slice(start, end);
        const eq = raw.indexOf('=');
        const fname = (eq < 0 ? raw : raw.slice(0, eq)).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(fname)) this.error(here, `'${fname}' is not a valid argument name for the macro ${name}.`, out);
        else if (formals!.some((f) => f.name === fname)) this.error(here, `The macro ${name} has two arguments called '${fname}'.`, out);
        else {
          const f: Formal = { name: fname };
          if (eq >= 0) {
            let ds = start + eq + 1;
            let de = end;
            while (ds < de && isSpace(text[ds])) ds++;
            while (de > ds && isSpace(text[de - 1])) de--;
            f.def = { file, start: base(ds), end: base(ds) + (de - ds) };
          }
          formals!.push(f);
        }
      };
      let closed = false;
      while (p < n && !isNewline(text[p])) {
        const ch = text[p]!;
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' && depth === 0) {
          if (start < p || formals.length > 0) flush(p);
          p++;
          closed = true;
          break;
        } else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) {
          flush(p);
          start = p + 1;
        }
        p++;
      }
      if (!closed) this.error(here, `The argument list of the macro ${name} is never closed. Add ')'.`, out);
    }
    // The body runs to the end of the line, and past it where a backslash continues the line.
    while (isBlank(text[p])) p++;
    const segs: [number, number][] = [];
    let segStart = p;
    while (p < n) {
      const ch = text[p]!;
      if (isNewline(ch)) break;
      if (ch === '\\' && (text[p + 1] === '\n' || text[p + 1] === '\r')) {
        segs.push([segStart, p]);
        p++;
        segStart = p;
        p += text[p] === '\r' && text[p + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (ch === '"') {
        let q = p + 1;
        while (q < n && text[q] !== '"' && !isNewline(text[q])) q += text[q] === '\\' ? 2 : 1;
        p = text[q] === '"' ? q + 1 : q;
        continue;
      }
      if (ch === '/' && text[p + 1] === '/') {
        segs.push([segStart, p]);
        while (p < n && !isNewline(text[p])) p++;
        segStart = p;
        break;
      }
      if (ch === '/' && text[p + 1] === '*') {
        const close = text.indexOf('*/', p + 2);
        let eol = p;
        while (eol < n && !isNewline(text[eol])) eol++;
        if (close < 0 || close > eol) {
          this.error(src.originAt(p), `A comment inside the \`define of ${name} must end on the same line.`, out);
          p = eol;
          break;
        }
        segs.push([segStart, p]);
        p = close + 2;
        segStart = p;
        continue;
      }
      p++;
    }
    segs.push([segStart, p]);
    const parts: Part[] = [];
    const formalIndex = new Map((formals ?? []).map((f, k) => [f.name, k] as const));
    const TOKEN = /[A-Za-z_][A-Za-z0-9_$]*|"(?:\\.|[^"\\])*"?|``|`[A-Za-z_][A-Za-z0-9_$]*/g;
    for (const [a, b] of segs) {
      if (a >= b) continue;
      const piece = text.slice(a, b);
      let last = 0;
      const addText = (from2: number, to2: number) => {
        if (from2 < to2) parts.push({ kind: 'text', file, start: base(a) + from2, end: base(a) + to2 });
      };
      TOKEN.lastIndex = 0;
      for (let tm = TOKEN.exec(piece); tm; tm = TOKEN.exec(piece)) {
        const tok = tm[0];
        if (tok === '``') {
          addText(last, tm.index);
          last = tm.index + 2;
        } else if (formalIndex.has(tok)) {
          addText(last, tm.index);
          parts.push({ kind: 'arg', index: formalIndex.get(tok)! });
          last = tm.index + tok.length;
        }
      }
      addText(last, piece.length);
    }
    this.macros.set(name, { name, formals, parts });
    return p;
  }

  // ------------------------------------------------------------ include

  private include(path: string, here: Origin, out: Out, depth: number) {
    const dir = dirname(here.file.name);
    const candidates = [path, normalize(dir ? `${dir}/${path}` : path)];
    const files = this.opts.files ?? {};
    const found = candidates.find((c) => c in files);
    if (found === undefined) {
      this.error(here, `Cannot open the include file "${path}". Pass it in the 'files' option.`, out);
      return;
    }
    if (this.includeStack.includes(found)) {
      this.error(here, `\`include cycle: ${[...this.includeStack, found].join(' includes ')}.`, out);
      return;
    }
    if (this.includeStack.length >= MAX_INCLUDE_DEPTH) {
      this.error(here, `\`include is nested more than ${MAX_INCLUDE_DEPTH} files deep.`, out);
      return;
    }
    let entry = this.files.get(found);
    if (!entry) {
      entry = new FileEntry(found, files[found]!, false);
      this.files.set(found, entry);
    }
    this.includeStack.push(found);
    this.scan(new FileSrc(entry), out, depth);
    this.includeStack.pop();
  }

  // ------------------------------------------------------------ macro use

  private use(src: Src, name: string, afterName: number, here: Origin, out: Out, depth: number): number {
    const text = src.text;
    const n = text.length;
    const macro = this.macros.get(name);
    if (!macro) {
      this.error(here, `The macro \`${name} is not defined. Define it with \`define ${name} ... first.`, out);
      return afterName;
    }
    const chain = this.expanding.includes(name) ? [...this.expanding.slice(this.expanding.indexOf(name)), name] : undefined;
    if (chain) {
      this.error(here, `The macro \`${name} expands into itself (${chain.map((c) => `\`${c}`).join(' -> ')}).`, out);
      return afterName;
    }
    if (depth >= MAX_EXPANSION_DEPTH) {
      this.error(here, `Macros are nested more than ${MAX_EXPANSION_DEPTH} levels deep.`, out);
      return afterName;
    }
    let p = afterName;
    const args: Chunk[][] = [];
    if (macro.formals) {
      let q = p;
      while (isSpace(text[q])) q++;
      if (text[q] !== '(') {
        this.error(here, `The macro \`${name} takes ${macro.formals.length} argument${macro.formals.length === 1 ? '' : 's'}. Write \`${name}(...).`, out);
        return afterName;
      }
      // Arguments run to the ')' that matches, and split at commas outside brackets and strings.
      p = q + 1;
      let depthB = 0;
      let start = p;
      const raw: [number, number][] = [];
      let closed = false;
      while (p < n) {
        const ch = text[p]!;
        if (ch === '"') {
          let r = p + 1;
          while (r < n && text[r] !== '"' && !isNewline(text[r])) r += text[r] === '\\' ? 2 : 1;
          p = text[r] === '"' ? r + 1 : r;
          continue;
        }
        if (ch === '/' && text[p + 1] === '/') {
          while (p < n && !isNewline(text[p])) p++;
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depthB++;
        else if ((ch === ')' || ch === ']' || ch === '}') && depthB > 0) depthB--;
        else if (ch === ')') {
          raw.push([start, p]);
          p++;
          closed = true;
          break;
        } else if (ch === ',' && depthB === 0) {
          raw.push([start, p]);
          start = p + 1;
        }
        p++;
      }
      if (!closed) {
        this.error(here, `The arguments of \`${name} are never closed. Add ')'.`, out);
        return n;
      }
      const formals = macro.formals;
      if (formals.length === 0 && raw.length === 1 && text.slice(raw[0]![0], raw[0]![1]).trim() === '') raw.length = 0;
      if (raw.length > formals.length) {
        this.error(here, `\`${name} takes ${formals.length} argument${formals.length === 1 ? '' : 's'}, but ${raw.length} were given.`, out);
        return p;
      }
      for (let k = 0; k < formals.length; k++) {
        const r = raw[k];
        let a = r ? r[0] : 0;
        let b = r ? r[1] : 0;
        while (a < b && isSpace(text[a])) a++;
        while (b > a && isSpace(text[b - 1])) b--;
        if (a < b) {
          const tmp = new Out();
          this.scan(new ChunkSrc(src.slice(a, b)), tmp, depth + 1);
          args.push(tmp.chunks);
        } else if (formals[k]!.def) {
          const d = formals[k]!.def!;
          args.push([{ text: d.file.text.slice(d.start, d.end), origin: { file: d.file, offset: d.start } }]);
        } else if (r !== undefined || k < raw.length) {
          args.push([]);
        } else {
          this.error(here, `\`${name} needs ${formals.length} argument${formals.length === 1 ? '' : 's'}, but ${raw.length} ${raw.length === 1 ? 'was' : 'were'} given.`, out);
          return p;
        }
      }
    }
    const frame: Frame = { macro: name, use: here };
    const chunks: Chunk[] = [];
    for (const part of macro.parts) {
      if (part.kind === 'arg') chunks.push(...(args[part.index] ?? []));
      else chunks.push({ text: part.file.text.slice(part.start, part.end), origin: { file: part.file, offset: part.start, exp: frame } });
    }
    if (chunks.length > 0) {
      this.expanding.push(name);
      this.scan(new ChunkSrc(chunks), out, depth + 1);
      this.expanding.pop();
    }
    return p;
  }
}

/** Preprocess `source`. Problems are reported to `sink` and the text is still returned, as far as it could be built. */
export function preprocess(source: string, opts: PreprocessOptions, sink: DiagnosticSink): PreprocessResult {
  if (!source.includes('`') && !opts.defines) return { text: source, map: new SourceMap(source), directives: [] };
  return new Preprocessor(sink, opts).run(source);
}
