import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@ihatecircuits/core/parts';
import { StringStream } from '@codemirror/language';
import { KEYWORDS } from '@ihatecircuits/hdl/lexer';
import { EXAMPLES } from '@ihatecircuits/core/examples';
import { newProject } from '@ihatecircuits/core/project';
import { useEditor } from '../src/state/store';
import { CompilerClient, type WorkerLike } from '../src/verilog/client';
import { handle, moduleNames } from '../src/verilog/engine';
import { VERILOG_EXAMPLES } from '../src/verilog/examples';
import { tokenize } from '../src/verilog/language';
import { addLowered, scopeTo } from '../src/verilog/merge';
import { countProblems, lineStarts, summarize, toProblems, type Request, type Response } from '../src/verilog/protocol';

const lint = (source: string, top?: string) => {
  const r = handle({ id: 1, kind: 'lint', source, top });
  if (r.kind !== 'lint') throw new Error('wrong kind');
  return r;
};
const build = (source: string, view: 'blocks' | 'gates' = 'blocks', top?: string) => {
  const r = handle({ id: 2, kind: 'build', source, view, top });
  if (r.kind !== 'build') throw new Error('wrong kind');
  return r;
};

const HALF = `module half_adder(input a, input b, output s, output c);
  assign s = a ^ b;
  assign c = a & b;
endmodule
`;

describe('toProblems', () => {
  it('puts an error on the line the compiler names', () => {
    const src = 'module m(input a, output y);\n  assign y = a\nendmodule\n';
    const r = lint(src);
    const err = r.problems.find((p) => p.level === 'error')!;
    expect(err).toBeDefined();
    expect(src.slice(0, err.from).split('\n').length).toBe(err.line);
    expect(err.from).toBeLessThan(err.to);
  });

  it('never lets a marker cross a line end or leave the text', () => {
    const src = 'module m(input a, output y);\r\n  assign y = a\r\nendmodule';
    for (const p of lint(src).problems) {
      expect(p.from).toBeGreaterThanOrEqual(0);
      expect(p.to).toBeLessThanOrEqual(src.length);
      expect(src.slice(p.from, p.to)).not.toMatch(/[\r\n]/);
    }
  });

  it('uses line and column, so a `define above does not shift the marker', () => {
    const src = '`define W 4\nmodule m(input [`W-1:0] a, output y);\n  assign y = nope;\nendmodule\n';
    const err = lint(src).problems.find((p) => p.level === 'error')!;
    expect(err.line).toBe(3);
    expect(src.slice(err.from, err.to)).toContain('nope');
  });

  it('summarises counts in plain words', () => {
    const mk = (level: 'error' | 'warning' | 'info') => ({ level, code: 'x', message: '', line: 1, col: 1, from: 0, to: 1 });
    expect(summarize([])).toBe('No problems');
    expect(summarize([mk('error'), mk('warning'), mk('warning')])).toBe('1 error, 2 warnings');
    expect(countProblems([mk('info')])).toEqual({ error: 0, warning: 0, info: 1 });
  });

  it('indexes lines the way the compiler does', () => {
    expect(lineStarts('a\nb\r\nc\rd')).toEqual([0, 2, 5, 7]);
    expect(toProblems([], '')).toEqual([]);
  });
});

describe('engine', () => {
  it('lints a good module with no errors and lists its modules', () => {
    const r = lint(HALF);
    expect(r.problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(r.modules).toEqual(['half_adder']);
    expect(r.top).toBe('half_adder');
  });

  it('still lists the modules when the text has an error', () => {
    const src = `${HALF}module broken(input a, output y);\n  assign y = ;\nendmodule\n`;
    const r = lint(src);
    expect(r.problems.some((p) => p.level === 'error')).toBe(true);
    expect(r.modules).toEqual(['half_adder', 'broken']);
    expect(r.top).toBeUndefined();
    expect(moduleNames('not verilog at all')).toEqual([]);
  });

  it('honours the chosen top module and reports an unknown one', () => {
    const two = `${HALF}module wrap(input a, input b, output s); wire c; half_adder u(.a(a),.b(b),.s(s),.c(c)); endmodule\n`;
    expect(lint(two, 'half_adder').top).toBe('half_adder');
    expect(lint(two, 'nope').problems.some((p) => p.code === 'top-not-found')).toBe(true);
  });

  it('builds a project in either view', () => {
    for (const view of ['blocks', 'gates'] as const) {
      const r = build(HALF, view);
      expect(r.outcome.type).toBe('built');
      if (r.outcome.type === 'built') expect(r.outcome.project.circuits.length).toBeGreaterThan(0);
    }
  });

  it('blocks a build while the source has errors, with the problems to fix', () => {
    const r = build('module m(; endmodule');
    expect(r.outcome).toEqual({ type: 'blocked' });
    expect(r.problems.some((p) => p.level === 'error')).toBe(true);
  });

  it('turns a lowering error into a message and not a throw', () => {
    // A constant with an unknown bit has no circuit form, so the lowering refuses it.
    const r = build("module m(output [1:0] y); assign y = 2'bx0; endmodule");
    expect(r.outcome).toEqual({ type: 'failed', message: expect.stringContaining('x or z bits') });
  });

  it('exports the project it is given back to Verilog, and reports what it cannot export', () => {
    const lowered = build(HALF).outcome;
    if (lowered.type !== 'built') throw new Error('expected a build');
    const ok = handle({ id: 3, kind: 'export', project: lowered.project });
    expect(ok.kind === 'export' && ok.text).toMatch(/module/);
    const bad = handle({ id: 4, kind: 'export', project: EXAMPLES.find((e) => e.id === 'half-adder')!.build() });
    expect(bad).toMatchObject({ kind: 'export', error: expect.stringMatching(/cannot be exported.*Pin parts/) });
    expect(bad.kind === 'export' && bad.text).toBeUndefined();
  });
});

describe('addLowered', () => {
  const FULL = VERILOG_EXAMPLES.find((e) => e.id === 'adders')!.source;
  const lowered = (src: string, view: 'blocks' | 'gates' = 'blocks') => {
    const o = build(src, view).outcome;
    if (o.type !== 'built') throw new Error(`no build: ${o.type}`);
    return o.project;
  };

  it('adds the top and its submodules, remaps ids and keeps the project main', () => {
    const base = newProject('mine');
    const r = addLowered(base, lowered(FULL));
    expect(r.project.main).toBe('main');
    expect(r.project.circuits[0]).toBe(base.circuits[0]);
    expect(r.circuits).toBe(r.project.circuits.length - 1);
    const ids = r.project.circuits.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.topId).not.toBe('main');
    const top = r.project.circuits.find((c) => c.id === r.topId)!;
    expect(top.name).toBe('full_adder');
    const uses = Object.values(top.components).filter((c) => c.type.startsWith('sub:')).map((c) => c.type.slice(4));
    expect(uses.length).toBe(2);
    for (const u of uses) expect(r.project.circuits.find((c) => c.id === u)?.name).toBe('half_adder');
    expect(r.parts).toBeGreaterThan(0);
  });

  it('adds fresh copies with numbered names when built again, and never touches existing circuits', () => {
    const l = lowered(FULL);
    const once = addLowered(newProject('mine'), l);
    const twice = addLowered(once.project, l);
    expect(twice.project.circuits.slice(0, once.project.circuits.length)).toEqual(once.project.circuits);
    const names = twice.project.circuits.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(twice.project.circuits.find((c) => c.id === twice.topId)!.name).toBe('full_adder 2');
    // The second set's top uses the second set's half adder, not the first one.
    const top = twice.project.circuits.find((c) => c.id === twice.topId)!;
    const usedIds = Object.values(top.components).filter((c) => c.type.startsWith('sub:')).map((c) => c.type.slice(4));
    for (const u of usedIds) expect(once.project.circuits.some((c) => c.id === u)).toBe(false);
  });

  it('adds each support circuit once in the gates view', () => {
    const src = 'module m(input [7:0] a, input [7:0] b, input [7:0] c, output [7:0] y, output [7:0] z); assign y = a + b; assign z = y + c; endmodule';
    const r = addLowered(newProject('mine'), lowered(src, 'gates'));
    const adders = r.project.circuits.filter((c) => /^add8/i.test(c.name));
    expect(adders.length).toBe(1);
  });

  it('does not reuse the name of a circuit the student drew', () => {
    const base = { ...newProject('mine'), circuits: [{ ...newProject().circuits[0]!, id: 'k2', name: 'half_adder' }, ...newProject().circuits] };
    const r = addLowered(base, lowered(HALF));
    expect(r.project.circuits.find((c) => c.id === r.topId)!.name).toBe('half_adder 2');
    expect(r.project.circuits.find((c) => c.id === 'k2')!.name).toBe('half_adder');
  });
});

describe('scopeTo', () => {
  it('keeps the open circuit as main with the circuits it uses, and drops the rest', () => {
    const o = build(VERILOG_EXAMPLES[0]!.source).outcome;
    if (o.type !== 'built') throw new Error('no build');
    const base = newProject('mine');
    const r = addLowered(base, o.project);
    const scoped = scopeTo(r.project, r.topId);
    expect(scoped.main).toBe(r.topId);
    expect(scoped.circuits.map((c) => c.name).sort()).toEqual(['full_adder', 'half_adder']);
    expect(scopeTo(r.project, 'main').circuits.map((c) => c.id)).toEqual(['main']);
  });
});

describe('store: a build is one undo step', () => {
  it('opens the new circuit and undo takes the whole set away', () => {
    const st = useEditor.getState();
    st.load(newProject('t'));
    const before = useEditor.getState();
    const o = build(VERILOG_EXAMPLES[0]!.source).outcome;
    if (o.type !== 'built') throw new Error('no build');
    const added = addLowered(before.project, o.project);
    before.commitBuilt(added.project, added.topId);
    expect(useEditor.getState().active).toBe(added.topId);
    expect(useEditor.getState().project.circuits.length).toBe(1 + added.circuits);
    useEditor.getState().undo();
    expect(useEditor.getState().project.circuits.length).toBe(1);
    expect(useEditor.getState().active).toBe('main');
  });
});

describe('examples', () => {
  it.each(VERILOG_EXAMPLES.map((e) => [e.id, e.source] as const))('%s compiles without errors and lowers in both views', (_id, source) => {
    const l = lint(source);
    expect(l.problems.filter((p) => p.level === 'error')).toEqual([]);
    for (const view of ['blocks', 'gates'] as const) {
      const r = build(source, view);
      expect(r.outcome.type, `${view}: ${JSON.stringify(r.problems)}`).toBe('built');
    }
  });

  it('has between six and eight examples with distinct ids', () => {
    expect(VERILOG_EXAMPLES.length).toBeGreaterThanOrEqual(6);
    expect(VERILOG_EXAMPLES.length).toBeLessThanOrEqual(8);
    expect(new Set(VERILOG_EXAMPLES.map((e) => e.id)).size).toBe(VERILOG_EXAMPLES.length);
  });
});

describe('language', () => {
  const tokens = (line: string) => {
    const state = { inBlockComment: false };
    const s = new StringStream(line, 2, 2);
    const out: [string, string | null][] = [];
    while (!s.eol()) {
      s.start = s.pos;
      const t = tokenize(s, state);
      if (t) out.push([s.current(), t]);
    }
    return out;
  };

  it('marks every reserved word of the compiler as a keyword or type', () => {
    for (const w of KEYWORDS) {
      const t = tokens(w);
      expect(t.length, w).toBe(1);
      expect(['keyword', 'typeName'], w).toContain(t[0]![1]);
    }
  });

  it('highlights numbers, comments, strings and directives', () => {
    expect(tokens("4'b10x1")).toEqual([["4'b10x1", 'number']]);
    expect(tokens("'hFF")).toEqual([["'hFF", 'number']]);
    expect(tokens('// note')[0]).toEqual(['// note', 'comment']);
    expect(tokens('"hi"')).toEqual([['"hi"', 'string']]);
    expect(tokens('`define W 4')[0]).toEqual(['`define', 'meta']);
    expect(tokens('$display')[0]).toEqual(['$display', 'meta']);
    expect(tokens('count')).toEqual([]);
  });

  it('carries a block comment across lines', () => {
    const state = { inBlockComment: false };
    const a = new StringStream('/* start', 2, 2);
    expect(tokenize(a, state)).toBe('comment');
    expect(state.inBlockComment).toBe(true);
    const b = new StringStream('end */ wire', 2, 2);
    expect(tokenize(b, state)).toBe('comment');
    expect(state.inBlockComment).toBe(false);
    b.eatSpace();
    b.start = b.pos;
    expect(tokenize(b, state)).toBe('typeName');
  });
});

/** A worker that answers on demand, so the test decides when and whether it replies. */
class FakeWorker implements WorkerLike {
  sent: Request[] = [];
  terminated = false;
  onmessage: ((e: { data: Response }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  postMessage(m: Request) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(r: Response) {
    this.onmessage?.({ data: r });
  }
}

describe('CompilerClient', () => {
  let workers: FakeWorker[];
  const make = (ms = 5000) =>
    new CompilerClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, ms);
  const lintReply = (id: number): Response => ({ id, kind: 'lint', problems: [], modules: [] });
  beforeEach(() => {
    workers = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('gives each request an id and matches the answer to it', async () => {
    const c = make();
    const p = c.request<'lint'>({ kind: 'lint', source: 'a' });
    const sent = workers[0]!.sent[0]!;
    workers[0]!.reply(lintReply(sent.id));
    await expect(p).resolves.toEqual({ type: 'ok', response: lintReply(sent.id) });
  });

  it('drops the answer to an older request of the same kind', async () => {
    const c = make();
    const first = c.request<'lint'>({ kind: 'lint', source: 'a' });
    const second = c.request<'lint'>({ kind: 'lint', source: 'ab' });
    await expect(first).resolves.toEqual({ type: 'stale' });
    const [a, b] = workers[0]!.sent;
    workers[0]!.reply(lintReply(a!.id));
    workers[0]!.reply(lintReply(b!.id));
    const r = await second;
    expect(r.type === 'ok' && r.response.id).toBe(b!.id);
  });

  it('does not let a lint replace a build in flight', async () => {
    const c = make();
    const b = c.request<'build'>({ kind: 'build', source: 'a', view: 'blocks' });
    const l = c.request<'lint'>({ kind: 'lint', source: 'a' });
    const [bs, ls] = workers[0]!.sent;
    workers[0]!.reply({ id: bs!.id, kind: 'build', problems: [], modules: [], outcome: { type: 'blocked' } });
    workers[0]!.reply(lintReply(ls!.id));
    expect((await b).type).toBe('ok');
    expect((await l).type).toBe('ok');
  });

  it('terminates a silent worker after 5 seconds, replaces it and carries on', async () => {
    const c = make();
    const p = c.request<'lint'>({ kind: 'lint', source: 'a' });
    vi.advanceTimersByTime(4999);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    await expect(p).resolves.toEqual({ type: 'timeout' });
    expect(workers[0]!.terminated).toBe(true);
    const next = c.request<'lint'>({ kind: 'lint', source: 'b' });
    expect(workers).toHaveLength(2);
    workers[1]!.reply(lintReply(workers[1]!.sent[0]!.id));
    expect((await next).type).toBe('ok');
  });

  it('ignores a late answer from a worker it already replaced', async () => {
    const c = make();
    const p = c.request<'lint'>({ kind: 'lint', source: 'a' });
    const oldId = workers[0]!.sent[0]!.id;
    vi.advanceTimersByTime(6000);
    await p;
    const next = c.request<'lint'>({ kind: 'lint', source: 'b' });
    workers[0]!.reply(lintReply(oldId));
    workers[1]!.reply(lintReply(workers[1]!.sent[0]!.id));
    const r = await next;
    expect(r.type === 'ok' && r.response.id).toBe(workers[1]!.sent[0]!.id);
  });

  it('reports a worker error as a crash and starts a new worker next time', async () => {
    const c = make();
    const p = c.request<'lint'>({ kind: 'lint', source: 'a' });
    workers[0]!.onerror?.({ message: 'boom' });
    await expect(p).resolves.toEqual({ type: 'crashed', message: 'boom' });
    void c.request<'lint'>({ kind: 'lint', source: 'b' });
    expect(workers).toHaveLength(2);
  });

  it('clears the watchdog when the answer arrives in time', async () => {
    const c = make();
    const p = c.request<'lint'>({ kind: 'lint', source: 'a' });
    workers[0]!.reply(lintReply(workers[0]!.sent[0]!.id));
    await p;
    vi.advanceTimersByTime(60000);
    expect(workers[0]!.terminated).toBe(false);
  });
});
