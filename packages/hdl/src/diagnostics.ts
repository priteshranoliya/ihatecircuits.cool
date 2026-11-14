/**
 * Source locations and diagnostics shared by every compiler phase.
 */

export type Severity = 'error' | 'warning';

/**
 * Where a piece of text came from when it is the result of a macro expansion: the macro, and the place it was
 * used. A macro used inside another macro's text has an `outer` frame for the use that caused it.
 */
export interface Expansion {
  macro: string;
  /** The file holding the use, when it is not the main file. */
  file?: string;
  line: number;
  col: number;
  outer?: Expansion;
}

/**
 * A region of the source. `start`/`end` are UTF-16 offsets (end exclusive) into the text the lexer saw, which
 * is the preprocessed text and so equals the source text when there are no directives. `line`/`col` are 1-based
 * and locate `start` in the original file; `file` names that file when it is not the main one, and `expansion`
 * says which macro the text came from.
 */
export interface Span {
  start: number;
  end: number;
  line: number;
  col: number;
  file?: string;
  expansion?: Expansion;
}

/** Stable identifiers for the kinds of problem the compiler reports. */
export type DiagnosticCode =
  | 'lex-error'
  | 'preprocess-error'
  | 'syntax-error'
  | 'not-supported'
  | 'no-modules'
  | 'duplicate-module'
  | 'top-not-found'
  | 'ambiguous-top'
  | 'recursive-instantiation'
  | 'unknown-module'
  | 'redeclared'
  | 'bad-declaration'
  | 'undeclared'
  | 'bad-range'
  | 'bad-select'
  | 'bad-width'
  | 'width-limit'
  | 'bad-assignment'
  | 'multiple-drivers'
  | 'bad-clock'
  | 'bad-connection'
  | 'bad-literal'
  | 'undriven'
  | 'literal-truncated'
  | 'literal-too-large'
  | 'use-before-declaration'
  | 'too-deep'
  | 'internal-error'
  | 'if-unknown-condition'
  | 'gated-clock'
  | 'not-synthesizable'
  | 'not-constant'
  | 'bad-parameter'
  | 'bad-generate'
  | 'bad-loop'
  | 'bad-async-reset'
  | 'x-comparison'
  | 'latch-inferred'
  | 'incomplete-sensitivity'
  | 'unused-signal'
  | 'width-truncation'
  | 'mixed-assignment'
  | 'comb-loop'
  | 'case-attribute'
  | 'ignored';

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  message: string;
  span: Span;
}

/** Maps offsets in a source text to lines and columns. */
export class SourceMap {
  private readonly lineStarts: number[];

  constructor(readonly text: string) {
    // A byte order mark is not a column.
    this.lineStarts = [text.charCodeAt(0) === 0xfeff ? 1 : 0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // A line ends at \n, \r\n or a lone \r.
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) this.lineStarts.push(i + 1);
    }
  }

  span(start: number, end: number): Span {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= start) lo = mid;
      else hi = mid - 1;
    }
    return { start, end, line: lo + 1, col: start - this.lineStarts[lo]! + 1 };
  }
}

/** Collects diagnostics in the order they are reported. */
export class DiagnosticSink {
  readonly items: Diagnostic[] = [];

  report(severity: Severity, code: DiagnosticCode, message: string, span: Span) {
    this.items.push({ severity, code, message: span.expansion ? `${message} ${describeExpansion(span.expansion)}` : message, span });
  }
  error(code: DiagnosticCode, message: string, span: Span) {
    this.report('error', code, message, span);
  }
  warning(code: DiagnosticCode, message: string, span: Span) {
    this.report('warning', code, message, span);
  }
  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}

/** `(in macro X, expanded at line N)`, followed by the same for the macro that contains the use. */
export function describeExpansion(e: Expansion): string {
  let out = `(in macro ${e.macro}, expanded at ${e.file ? `${e.file} ` : ''}line ${e.line}`;
  let n = 1;
  for (let o = e.outer; o; o = o.outer) {
    if (++n > 4) {
      out += ', and so on';
      break;
    }
    out += `, inside macro ${o.macro}, expanded at ${o.file ? `${o.file} ` : ''}line ${o.line}`;
  }
  return `${out})`;
}

/** A literal or name shortened for a message, so a huge number does not flood the output. */
export function abbreviate(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `line:col: error [code]: message`, for logs and error strings. */
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.span.file ? `${d.span.file}:` : ''}${d.span.line}:${d.span.col}: ${d.severity} [${d.code}]: ${d.message}`;
}

/** Smallest span covering both. */
export function joinSpans(a: Span, b: Span): Span {
  const first = a.start <= b.start ? a : b;
  const out: Span = { start: first.start, end: Math.max(a.end, b.end), line: first.line, col: first.col };
  if (first.file !== undefined) out.file = first.file;
  if (first.expansion !== undefined) out.expansion = first.expansion;
  return out;
}
