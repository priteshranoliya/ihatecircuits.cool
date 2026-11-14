import { handle } from './engine';
import type { Request } from './protocol';

// The DOM lib types `self` as a Window, so state the one thing this file needs from a worker scope.
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => scope.postMessage(handle(e.data));
