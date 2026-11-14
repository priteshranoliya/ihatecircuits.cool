/**
 * Our own small Verilog highlighter: a tokenizer for CodeMirror's StreamLanguage.
 * The reserved words come from the compiler's lexer, so the editor and the compiler agree on what a keyword is.
 */
import { HighlightStyle, StreamLanguage, type StringStream, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { KEYWORDS } from '@ihatecircuits/hdl/lexer';

/** Words that name a kind of signal or a number type. The rest of the reserved words are plain keywords. */
const TYPE_WORDS = new Set('wire reg integer real realtime time tri tri0 tri1 triand trior trireg wand wor supply0 supply1 uwire genvar event'.split(' '));

interface State {
  inBlockComment: boolean;
}

// A based literal: 4'b1010, 'hFF, 8'sd-free forms. The size and the base letter come first, then digits, x, z, ? and _.
const BASED = /^(?:\d[\d_]*)?'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ?_]+/;
const DECIMAL = /^\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/;

export function tokenize(stream: StringStream, state: State): string | null {
  if (state.inBlockComment) {
    while (!stream.eol()) {
      if (stream.match('*/')) {
        state.inBlockComment = false;
        break;
      }
      stream.next();
    }
    return 'comment';
  }
  if (stream.eatSpace()) return null;
  if (stream.match('//')) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.match('/*')) {
    state.inBlockComment = true;
    return tokenize(stream, state);
  }
  if (stream.peek() === '"') {
    stream.next();
    while (!stream.eol()) {
      const c = stream.next();
      if (c === '\\') stream.next();
      else if (c === '"') break;
    }
    return 'string';
  }
  if (stream.match(BASED) || stream.match(DECIMAL)) return 'number';
  // Compiler directives (`define, `ifdef) and system tasks ($display).
  if (stream.match(/^`[A-Za-z_]\w*/) || stream.match(/^\$[A-Za-z_][\w$]*/)) return 'meta';
  if (stream.match(/^[A-Za-z_][\w$]*/)) {
    const word = stream.current();
    if (TYPE_WORDS.has(word)) return 'typeName';
    return KEYWORDS.has(word) ? 'keyword' : null;
  }
  if (stream.match(/^[()[\]{}]/)) return 'bracket';
  if (stream.match(/^(?:<<<|>>>|===|!==|\*\*|<=|>=|==|!=|&&|\|\||<<|>>|~&|~\||~\^|\^~|\+:|-:|[-+*/%<>=!~&|^?:@#])/)) return 'operator';
  stream.next();
  return null;
}

export const verilog = StreamLanguage.define<State>({
  name: 'verilog',
  startState: () => ({ inBlockComment: false }),
  copyState: (s) => ({ ...s }),
  token: tokenize,
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

/** Colours come from CSS tokens (--syn-*), which styles.css redefines for dark mode. */
export const verilogHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--syn-keyword)', fontWeight: '500' },
    { tag: tags.typeName, color: 'var(--syn-type)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.string, color: 'var(--syn-string)' },
    { tag: [tags.meta, tags.processingInstruction], color: 'var(--syn-meta)' },
    { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
    { tag: tags.operator, color: 'var(--text-muted)' },
  ]),
);
