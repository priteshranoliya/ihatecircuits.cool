/**
 * What the main thread and the compiler worker say to each other, and the pure helpers around it.
 *
 * Both sides are our own code, so messages are typed and cross as structured-clone plain objects.
 * A lowered Project is plain data (strings, numbers, records) and clones as is. Going through
 * serialize() and parseProject() would add a pretty-printed JSON string, a second parse and a
 * validation of data this repo just produced, with nothing to catch.
 */
import type { Diagnostic } from '@ihatecircuits/hdl';
import type { Project } from '@ihatecircuits/core/types';

export type View = 'blocks' | 'gates';
export type Level = 'error' | 'warning' | 'info';

/** A diagnostic placed in the editor text: offsets are into the text that was compiled. */
export interface Problem {
  level: Level;
  code: string;
  message: string;
  /** 1-based, as the compiler reports them. */
  line: number;
  col: number;
  from: number;
  to: number;
}

export type Request =
  | { id: number; kind: 'lint'; source: string; top?: string }
  | { id: number; kind: 'build'; source: string; top?: string; view: View }
  | { id: number; kind: 'export'; project: Project };

export type BuildOutcome =
  | { type: 'built'; project: Project; top: string }
  /** The source has errors, so there is nothing to build. The problems say what to fix. */
  | { type: 'blocked' }
  /** The design compiled but could not be turned into parts. */
  | { type: 'failed'; message: string };

export type Response =
  | { id: number; kind: 'lint'; problems: Problem[]; modules: string[]; top?: string }
  | { id: number; kind: 'build'; problems: Problem[]; modules: string[]; top?: string; outcome: BuildOutcome }
  | { id: number; kind: 'export'; text?: string; error?: string };

export type Kind = Request['kind'];
export type ResponseOf<K extends Kind> = Extract<Response, { kind: K }>;
/** A request as the caller writes it: the client adds the id. */
export type RequestBody<K extends Kind = Kind> = K extends Kind ? Omit<Extract<Request, { kind: K }>, 'id'> : never;

/** Offsets at which each line starts. A line ends at \n, \r\n or a lone \r, as in the compiler. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return starts;
}

const levelOf = (d: Diagnostic): Level => {
  // The compiler says a construct was accepted and has no effect. That is a note, not a warning.
  if (d.code === 'ignored') return 'info';
  const s: string = d.severity;
  return s === 'error' || s === 'info' ? s : 'warning';
};

/**
 * Place compiler diagnostics in the text. Line and column are used rather than the span's offsets, because
 * the offsets are into the preprocessed text, which differs from the source once a `define or `include is used.
 * A marker never crosses a line end, so a diagnostic on a whole module underlines one line, not the file.
 */
export function toProblems(diagnostics: readonly Diagnostic[], source: string): Problem[] {
  const starts = lineStarts(source);
  const lineEnd = (i: number) => {
    const next = starts[i + 1];
    if (next === undefined) return source.length;
    let end = next;
    if (source[end - 1] === '\n') end--;
    if (source[end - 1] === '\r') end--;
    return end;
  };
  const out = diagnostics.map((d): Problem => {
    const inOtherFile = d.span.file !== undefined;
    const line = inOtherFile ? 1 : Math.min(Math.max(1, d.span.line), starts.length);
    const col = inOtherFile ? 1 : Math.max(1, d.span.col);
    const start = starts[line - 1]!;
    const end = lineEnd(line - 1);
    let from = Math.min(start + col - 1, end);
    const length = Math.max(1, d.span.end - d.span.start);
    let to = Math.min(from + length, end);
    // A diagnostic at the end of a line still needs something to underline.
    if (to === from && from > start) from--;
    if (to === from) to = Math.min(from + 1, source.length);
    const message = inOtherFile ? `In ${d.span.file}: ${d.message}` : d.message;
    return { level: levelOf(d), code: d.code, message, line, col, from, to };
  });
  return out.sort((a, b) => a.from - b.from);
}

export function countProblems(problems: readonly Problem[]): Record<Level, number> {
  const n: Record<Level, number> = { error: 0, warning: 0, info: 0 };
  for (const p of problems) n[p.level]++;
  return n;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 errors, 1 warning" or "No problems". */
export function summarize(problems: readonly Problem[]): string {
  const n = countProblems(problems);
  const parts = [n.error && plural(n.error, 'error'), n.warning && plural(n.warning, 'warning'), n.info && plural(n.info, 'note')].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No problems';
}
