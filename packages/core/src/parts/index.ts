import { register } from '../library';
import { ARITHMETIC } from './arith';
import { GATES } from './gates';
import { IO_EXTRA } from './ioextra';
import { MEMORY } from './memory';
import { PLEXERS } from './plexers';
import { INPUTS, NOTES, OUTPUTS } from './io';
import { SOURCES, WIRING } from './wiring';

/**
 * Registers every built-in part. Each family lives in its own file so the
 * library can grow without one giant module. Import this once, early.
 */
let done = false;
export function registerBuiltins() {
  if (done) return;
  done = true;
  register([...GATES, ...WIRING, ...SOURCES, ...INPUTS, ...OUTPUTS, ...IO_EXTRA, ...PLEXERS, ...ARITHMETIC, ...MEMORY, ...NOTES]);
}
registerBuiltins();
