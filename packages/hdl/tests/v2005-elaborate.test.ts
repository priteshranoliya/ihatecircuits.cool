import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile, formatDiagnostic } from '../src';
import { parseSource } from './ast-util';

/**
 * The handwritten corpus covers the grammar (IEEE 1364-2005 annex A), not just designs, so some files hold
 * things no circuit can be built from. Every file either elaborates with no error, or is listed here with the
 * reason, and with the error codes it is expected to give, so a file cannot start failing for a new reason.
 */
const UNSUPPORTED: Record<string, { reason: string; codes: string[] }> = {
  '01-ansi-ports.v': { reason: "inout port: the IR has no bidirectional port", codes: ["not-supported"] },
  '02-nonansi-ports.v': { reason: "inout port, and a real-valued constant", codes: ["not-supported"] },
  '03-port-expressions.v': { reason: "non-ANSI port expressions such as .p(a[3:0]) and {a, b}, deferred", codes: ["bad-connection", "bad-declaration", "not-supported", "undeclared"] },
  '05-param-port-list.v': { reason: "real-valued parameters", codes: ["not-supported"] },
  '06-parameters-localparam.v': { reason: "real-valued parameters", codes: ["not-supported"] },
  '07-defparam.v': { reason: "defparam to a grandchild instance (only a direct child is supported)", codes: ["not-supported"] },
  '08-port-declarations-misc.v': { reason: "inout port, a real constant, and an initial block assigning a wire", codes: ["bad-assignment", "not-supported"] },
  '10-vars-and-regs.v': { reason: "real and time variables", codes: ["not-supported", "not-synthesizable", "use-before-declaration", "width-limit"] },
  '11-arrays-memories.v': { reason: "multi-dimensional arrays, and real arrays", codes: ["bad-select", "not-supported", "use-before-declaration", "width-limit"] },
  '15-multi-declarators.v': { reason: "real, time and event variables", codes: ["not-supported", "not-synthesizable", "width-limit"] },
  '23-continuous-assign.v': { reason: "the file drives one net from several assigns on purpose (an invalid circuit)", codes: ["multiple-drivers"] },
  '24-gates-basic.v': { reason: "the file drives one net from several gates on purpose (an invalid circuit)", codes: ["multiple-drivers"] },
  '25-gates-tristate-mos.v': { reason: "switch-level primitives (nmos, pmos, cmos, tran...)", codes: ["not-supported"] },
  '26-gates-pull-delay-strength.v': { reason: "switch-level primitives, and nets driven by several gates on purpose", codes: ["multiple-drivers", "not-supported"] },
  '27-gate-arrays.v': { reason: "switch-level primitives, and nets driven by several gates on purpose", codes: ["multiple-drivers", "not-supported"] },
  '28-udp-combinational.v': { reason: "user-defined primitives (UDPs)", codes: ["not-supported"] },
  '29-udp-sequential-level.v': { reason: "user-defined primitives (UDPs)", codes: ["not-supported"] },
  '30-udp-sequential-edge.v': { reason: "user-defined primitives (UDPs)", codes: ["not-supported"] },
  '31-udp-ansi-style.v': { reason: "user-defined primitives (UDPs)", codes: ["not-supported"] },
  '32-udp-instances.v': { reason: "user-defined primitives (UDPs)", codes: ["not-supported"] },
  '35-instance-arrays-multi.v': { reason: "an instance array whose outputs drive the same bits on purpose", codes: ["multiple-drivers"] },
  '36-instance-delay-gatelike.v': { reason: "a net driven by an instance and a gate on purpose", codes: ["multiple-drivers"] },
  '37-hier-names-in-module.v': { reason: "hierarchical reference into an instance, and delays in a statement", codes: ["not-supported", "not-synthesizable"] },
  '45-functions-types-automatic.v': { reason: "real variables", codes: ["not-supported", "use-before-declaration"] },
  '46-functions-oldstyle-misc.v': { reason: "real variables in a function", codes: ["not-supported"] },
  '47-tasks-basic.v': { reason: "task calls inside a testbench initial block", codes: ["not-synthesizable"] },
  '48-tasks-automatic-disable.v': { reason: "task calls inside a testbench initial block", codes: ["not-synthesizable"] },
  '49-system-calls-in-funcs.v': { reason: "real and time variables, and $random", codes: ["not-supported", "width-limit"] },
  '50-assign-delays-events.v': { reason: "event variables and a testbench initial block", codes: ["not-synthesizable"] },
  '51-if-else.v': { reason: "initial block that drives signals (a testbench)", codes: ["not-synthesizable"] },
  '52-case-forms.v': { reason: "initial block that drives signals (a testbench)", codes: ["not-synthesizable"] },
  '53-loops.v': { reason: "initial block that drives signals (a testbench)", codes: ["not-synthesizable"] },
  '54-blocks-named-decls.v': { reason: "real variables in a function, and fork/join", codes: ["not-supported", "not-synthesizable"] },
  '55-delay-event-forms.v': { reason: "real and event variables, delays and event controls in statements, a reset not written as if (rst)", codes: ["bad-async-reset", "not-supported", "not-synthesizable"] },
  '56-wait-event-disable-pca.v': { reason: "event variables, wait, and procedural assign/force", codes: ["not-synthesizable"] },
  '57-task-enable-system-tasks.v': { reason: "real and time variables, and task calls in a testbench", codes: ["not-supported", "not-synthesizable", "width-limit"] },
  '58-tricky-statements.v': { reason: "always blocks without an event list, and a testbench initial block", codes: ["not-constant", "not-synthesizable"] },
  '59-expr-binary-operators.v': { reason: "=== and !== (hardware cannot see x or z)", codes: ["x-comparison"] },
  '62-expr-selects.v': { reason: "multi-dimensional arrays", codes: ["not-supported", "use-before-declaration"] },
  '63-expr-literals.v': { reason: "real variables, and a string held in a 64-bit reg", codes: ["not-supported", "use-before-declaration", "width-limit"] },
  '64-expr-identifiers-names.v': { reason: "a testbench initial block and a name the file leaves undeclared", codes: ["not-synthesizable", "undeclared"] },
  '65-expr-hier-and-sys.v': { reason: "real variable and hierarchical reference into an instance", codes: ["not-supported"] },
  '66-attrs-modules-decls.v': { reason: "inout port, real, time and event variables", codes: ["not-supported", "not-synthesizable", "width-limit"] },
  '67-attrs-instances-stmts.v': { reason: "event variables and a testbench initial block", codes: ["not-synthesizable"] },
  '68-attrs-expressions.v': { reason: "!== (hardware cannot see x or z)", codes: ["x-comparison"] },
  '69-attrs-vs-star-events.v': { reason: "initial block that drives signals (a testbench)", codes: ["not-synthesizable"] },
  '70-lexical-comments.v': { reason: "initial block that drives signals (a testbench)", codes: ["not-synthesizable"] },
  '72-lexical-spacing-tokens.v': { reason: "=== and !== (hardware cannot see x or z)", codes: ["x-comparison"] },
  '73-lexical-string-continuation.v': { reason: "a string held in a 160-bit reg, and $display in an initial block", codes: ["not-synthesizable", "width-limit"] },
  '75-crlf-tabs-case.v': { reason: "$display in an initial block", codes: ["not-synthesizable"] },
  '83-design-testbench.v': { reason: "a testbench: delays, an always block with no event list, $dumpfile", codes: ["not-synthesizable"] },
  '85-design-adder-tree.v': { reason: "a 64-bit port and multi-dimensional arrays", codes: ["bad-select", "not-supported", "width-limit"] },
  '86-design-timescale-nettype.v': { reason: "a delay in an initial block", codes: ["not-synthesizable"] },
  '87-design-timescale-delays.v': { reason: "an always block with no event list (a clock generator)", codes: ["not-synthesizable"] },
  '88-mintypmax.v': { reason: "a net driven by an assign and a tri-state gate on purpose, and delays in a statement", codes: ["multiple-drivers", "not-synthesizable"] },
  '89-expr-precedence-chains.v': { reason: "** with an exponent that is not constant, and ===", codes: ["not-supported", "x-comparison"] },
};

const dir = join(dirname(fileURLToPath(import.meta.url)), 'v2005');
const files = readdirSync(dir).filter((f) => f.endsWith('.v')).sort();
const FILES = { 'ram.hex': '', 'rom.bin': '' };

function build(file: string) {
  const text = readFileSync(join(dir, file), 'utf8');
  const first = parseSource(text).file.modules[0]!.name.name;
  return compile(text, { top: first, files: FILES });
}

describe('the handwritten corpus goes through elaboration', () => {
  for (const f of files) {
    const expected = UNSUPPORTED[f];
    if (expected) {
      it(`${f} is not elaborated (${expected.reason})`, () => {
        const errors = build(f).diagnostics.filter((d) => d.severity === 'error');
        expect(errors.length, 'it gives an error').toBeGreaterThan(0);
        expect([...new Set(errors.map((d) => d.code))].sort()).toEqual(expected.codes);
        for (const d of errors) {
          expect(d.span.line).toBeGreaterThanOrEqual(1);
          if (d.code === 'not-supported') expect(d.message).toContain('not supported yet');
          if (d.code === 'not-synthesizable') expect(d.message).toContain('not synthesizable; a testbench feature');
        }
      });
    } else {
      it(`${f} elaborates with no errors`, () => {
        const r = build(f);
        expect(r.diagnostics.filter((d) => d.severity === 'error').map(formatDiagnostic)).toEqual([]);
        expect(r.design).toBeDefined();
      });
    }
  }

  it('lists only files that exist, and counts what is covered', () => {
    for (const f of Object.keys(UNSUPPORTED)) expect(files, f).toContain(f);
    expect(files.length - Object.keys(UNSUPPORTED).length).toBeGreaterThanOrEqual(33);
  });
});
