import { type Diagnostic, DiagnosticSink, SourceMap } from './diagnostics';
import type { Design } from './design';
import { elaborate } from './elaborate';
import { lex } from './lexer';
import { parse } from './parser';
import { preprocess } from './preprocess';

export const VERSION = '0.1.0';

export type * from './design';
export { cellInputs, cellOutputs, findModule, isStateful } from './design';
export type { Diagnostic, DiagnosticCode, Severity, Span } from './diagnostics';
export { formatDiagnostic } from './diagnostics';
export { KEYWORDS, lex } from './lexer';
export { parse, parseExpression } from './parser';
export { preprocess } from './preprocess';
export type { Directive, PreprocessOptions, PreprocessResult } from './preprocess';
export { print } from './print';
export { DiagnosticSink, SourceMap } from './diagnostics';
export type * as Ast from './ast';
export type { TracePort, Stimulus, CycleSample, TraceRequest, TraceResult, TraceRunner } from './trace';

export interface CompileOptions {
  /** Name of the top module. By default the one module that no other module instantiates. */
  top?: string;
  /** Name of the source text, shown in diagnostics about `include files and in `__FILE__. */
  fileName?: string;
  /** Files that `include can read, by path. */
  files?: Record<string, string>;
  /** Macros defined before the first line. */
  defines?: Record<string, string>;
}

export interface CompileResult {
  /** Present only when no error was reported. */
  design?: Design;
  /** Errors and warnings, in source order. */
  diagnostics: Diagnostic[];
}

/** Compile Verilog source text to an elaborated design. */
export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const sink = new DiagnosticSink();
  let map = new SourceMap(source);
  let design: Design | undefined;
  try {
    const pre = preprocess(source, { fileName: opts.fileName, files: opts.files, defines: opts.defines }, sink);
    map = pre.map;
    const tokens = lex(pre.map, sink);
    const file = parse(tokens, sink);
    design = elaborate(file, { top: opts.top, files: opts.files, directives: pre.directives }, sink);
  } catch (e) {
    design = undefined;
    const what = e instanceof Error ? e.message : String(e);
    sink.error('internal-error', `The compiler hit an internal error (${what}). This is a bug in the compiler, not in your design.`, map.span(0, 0));
  }
  const diagnostics = sink.items.map((d, i) => ({ d, i })).sort((a, b) => a.d.span.start - b.d.span.start || a.i - b.i).map((x) => x.d);
  return diagnostics.some((d) => d.severity === 'error') ? { diagnostics } : { design, diagnostics };
}
