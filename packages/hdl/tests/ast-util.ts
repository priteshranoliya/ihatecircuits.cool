import { DiagnosticSink, type Diagnostic } from '../src/diagnostics';
import type { SourceFile } from '../src/ast';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';
import { type PreprocessOptions, preprocess } from '../src/preprocess';

/** A tree without its `span` fields, for comparing two parses of the same program. */
export function stripSpans(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSpans);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== 'span' && v !== undefined) out[k] = stripSpans(v);
    return out;
  }
  return node;
}

export interface Parsed {
  file: SourceFile;
  diags: Diagnostic[];
}

export function parseSource(src: string, opts: PreprocessOptions = {}): Parsed {
  const sink = new DiagnosticSink();
  const pre = preprocess(src, opts, sink);
  const file = parse(lex(pre.map, sink), sink);
  return { file, diags: sink.items };
}
