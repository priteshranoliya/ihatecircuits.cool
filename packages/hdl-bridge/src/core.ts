/**
 * The pieces of @ihatecircuits/core this package uses, imported in one place.
 * Importing the parts registers every built-in part with the library.
 */
import '@ihatecircuits/core/parts';

export { addComponent, buildCircuit, connect, emptyCircuit, setWireMid, type CircuitDraft } from '@ihatecircuits/core/edit';
export { boundsOf, pinPoint, rotatePoint, wireRoute } from '@ihatecircuits/core/geometry';
export { getDef, sanitizeProps, type PinDef } from '@ihatecircuits/core/library';
export { portNames, splitterMap } from '@ihatecircuits/core/netlist';
export { circuitById, lookupIn, portsOf, subType, useProject } from '@ihatecircuits/core/project';
export { Simulator } from '@ihatecircuits/core/sim';
export { GRID, type Circuit, type Component, type Project, type Rotation } from '@ihatecircuits/core/types';
export { type Bits, bitAt, unknown } from '@ihatecircuits/core/bits';
