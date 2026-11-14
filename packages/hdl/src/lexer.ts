import { type DiagnosticSink, type SourceMap, type Span } from './diagnostics';

/**
 * Lexer for Verilog-2005 (IEEE 1364-2005 clause 3).
 *
 * It tokenises the whole language, not just the subset the compiler accepts,
 * so that later phases can say "not supported yet" at the right place instead
 * of failing on an unknown character. Every token carries its source span.
 */

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'system' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text; for identifiers the name (escaped identifiers lose their backslash). */
  text: string;
  span: Span;
}

/** Reserved words of IEEE 1364-2005 annex B. */
export const KEYWORDS: ReadonlySet<string> = new Set(
  `always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance integer join large liblist library localparam macromodule medium module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor`.split(/\s+/),
);

/** Operators and punctuation, longest first within each leading character. `(*` and `*)` are produced by hand (see `lex`). */
const OPERATORS = [
  '<<<', '>>>', '===', '!==', '&&&',
  '**', '<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '~&', '~|', '~^', '^~', '+:', '-:', '->', '=>', '*>',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '#', '@',
];
const OPERATORS_BY_FIRST = new Map<string, string[]>();
for (const op of OPERATORS) {
  const list = OPERATORS_BY_FIRST.get(op[0]!) ?? [];
  list.push(op);
  OPERATORS_BY_FIRST.set(op[0]!, list);
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentPart = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$');
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';
const isLineEnd = (c: string | undefined) => c === '\n' || c === '\r';
const BASE_LETTER = /[bBoOdDhH]/;
const BASED_DIGIT = /[0-9a-fA-FxXzZ?_]/;

export function lex(map: SourceMap, sink: DiagnosticSink): Token[] {
  const src = map.text;
  const out: Token[] = [];
  // A byte order mark is not part of the program.
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let inAttribute = false;

  const push = (kind: TokenKind, start: number, end: number, text = src.slice(start, end)) => out.push({ kind, text, span: map.span(start, end) });

  /** If a based-literal tail (`'b1010`, possibly after blanks) starts at `from`, return where its digits end. */
  const basedTail = (from: number): number | null => {
    let p = from;
    while (isSpace(src[p])) p++;
    if (src[p] !== "'") return null;
    p++;
    if (src[p] === 's' || src[p] === 'S') p++;
    if (!BASE_LETTER.test(src[p] ?? '')) return null;
    p++;
    while (isSpace(src[p])) p++;
    const digitsStart = p;
    while (BASED_DIGIT.test(src[p] ?? '')) p++;
    return p > digitsStart ? p : null;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && !isLineEnd(src[i])) i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) {
        sink.error('lex-error', 'This comment is never closed. Add */ to end it.', map.span(i, src.length));
        i = src.length;
      } else i = end + 2;
      continue;
    }
    if (c === '(' && src[i + 1] === '*') {
      // `(*)` and `(* )` are an event list that holds a star, as in @(*); anything else opens an attribute.
      let p = i + 2;
      while (isSpace(src[p])) p++;
      if (src[p] === ')') {
        push('op', i, i + 1);
        push('op', i + 1, i + 2);
        push('op', p, p + 1);
        i = p + 1;
      } else {
        push('op', i, i + 2);
        inAttribute = true;
        i += 2;
      }
      continue;
    }
    if (c === '*' && src[i + 1] === ')' && inAttribute) {
      push('op', i, i + 2);
      inAttribute = false;
      i += 2;
      continue;
    }
    if (c === '`') {
      let end = i;
      while (end < src.length && !isLineEnd(src[end])) end++;
      sink.error('not-supported', 'A compiler directive such as `define or `include reached the lexer without being preprocessed.', map.span(i, end));
      i = end;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < src.length && src[p] !== '"' && !isLineEnd(src[p])) p += src[p] === '\\' ? 2 : 1;
      if (src[p] !== '"') {
        sink.error('lex-error', 'This string is never closed. Add a closing quote.', map.span(i, Math.min(p, src.length)));
        push('string', i, Math.min(p, src.length));
        i = Math.min(p, src.length);
      } else {
        push('string', i, p + 1);
        i = p + 1;
      }
      continue;
    }
    if (c === '$') {
      let p = i + 1;
      while (isIdentPart(src[p])) p++;
      if (p === i + 1) sink.error('lex-error', "A '$' must be followed by a system task or function name.", map.span(i, i + 1));
      else push('system', i, p);
      i = p;
      continue;
    }
    if (c === '\\') {
      let p = i + 1;
      while (p < src.length && !isSpace(src[p])) p++;
      if (p === i + 1) sink.error('lex-error', "A '\\' must be followed by an identifier.", map.span(i, i + 1));
      else push('ident', i, p, src.slice(i + 1, p));
      i = p;
      continue;
    }
    if (isIdentStart(c)) {
      let p = i + 1;
      while (isIdentPart(src[p])) p++;
      const text = src.slice(i, p);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', i, p);
      i = p;
      continue;
    }
    if (isDigit(c) || (c === "'" && basedTail(i) !== null)) {
      let p = i;
      if (isDigit(c)) {
        while (isDigit(src[p]) || src[p] === '_') p++;
        const tail = basedTail(p);
        if (tail !== null) p = tail;
        else if (src[p] === '.' && isDigit(src[p + 1])) {
          p++;
          while (isDigit(src[p]) || src[p] === '_') p++;
          if (/[eE]/.test(src[p] ?? '') && /[0-9+-]/.test(src[p + 1] ?? '')) {
            p += 2;
            while (isDigit(src[p]) || src[p] === '_') p++;
          }
        } else if (/[eE]/.test(src[p] ?? '') && (isDigit(src[p + 1]) || (/[+-]/.test(src[p + 1] ?? '') && isDigit(src[p + 2])))) {
          p += 2;
          while (isDigit(src[p]) || src[p] === '_') p++;
        }
      } else p = basedTail(p)!;
      push('number', i, p);
      i = p;
      continue;
    }
    const op = OPERATORS_BY_FIRST.get(c)?.find((o) => src.startsWith(o, i));
    if (op) {
      push('op', i, i + op.length);
      i += op.length;
      continue;
    }
    sink.error('lex-error', `Unexpected character '${c}'.`, map.span(i, i + 1));
    i++;
  }
  push('eof', src.length, src.length, '');
  return out;
}
