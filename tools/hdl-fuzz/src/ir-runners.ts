import type { Design } from '@ihatecircuits/hdl/design';
import { type DesignTraceRequest, runDesign } from '@ihatecircuits/hdl/interp';
import type { Stimulus, TraceResult } from '@ihatecircuits/hdl/trace';
import { designToVerilog, exportVerilog, lowerToProject, runDesignOnSimulator, type View } from '@ihatecircuits/hdl-bridge';
import { iverilogRunner } from './iverilog';

/** Something that runs an IR design under the cycle-trace protocol. */
export interface DesignRunner {
  name: string;
  run: (req: DesignTraceRequest) => TraceResult | Promise<TraceResult>;
}

const topOf = (text: string) => /Top module: ([A-Za-z_][A-Za-z0-9_$]*)\./.exec(text)?.[1];

async function viaIverilog(text: string, clock: string | undefined, stimulus: Stimulus): Promise<TraceResult> {
  const top = topOf(text);
  if (!top) return { ok: false, error: 'the text does not name a top module' };
  return iverilogRunner({ source: text, top, clock, stimulus });
}

/** The IR printed as behavioural Verilog and run in Icarus: the independent reference for the IR's meaning. */
export const iverilogIr: DesignRunner = {
  name: 'iverilog-ir',
  run: (req) => viaIverilog(designToVerilog(req.design), req.clock, req.stimulus),
};

export const interpRunner: DesignRunner = { name: 'interp', run: runDesign };

export const simulatorRunner = (view: View): DesignRunner => ({
  name: `ihatecircuits-${view}`,
  run: (req) => runDesignOnSimulator(req.design, req, view),
});

/** Lower, export the circuit back to structural Verilog, and run that in Icarus: the lowering checked without our own simulator. */
export const exportedRunner = (view: View): DesignRunner => ({
  name: `export-${view}-iverilog`,
  run: (req) => {
    let text: string;
    try {
      text = exportVerilog(lowerToProject(req.design, { view }));
    } catch (e) {
      return { ok: false, error: `export failed: ${(e as Error).message}` };
    }
    return viaIverilog(text, req.clock, req.stimulus);
  },
});

/** The reference first, then everything compared against it. */
export const irReference: DesignRunner = iverilogIr;
export const irRunners: DesignRunner[] = [interpRunner, simulatorRunner('blocks'), simulatorRunner('gates'), exportedRunner('blocks'), exportedRunner('gates')];

export type { Design };
