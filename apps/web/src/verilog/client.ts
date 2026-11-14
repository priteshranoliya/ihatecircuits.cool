/**
 * The main thread's side of the compiler worker.
 *
 * - Every request has an id and the worker echoes it. A newer request of the same kind replaces an older one,
 *   so a slow answer to an old edit is dropped, never shown.
 * - A watchdog covers each request. If the worker is silent for `timeoutMs` it is terminated and replaced, and
 *   every request waiting on it ends as 'timeout'. The caller shows a calm message; the next request just works.
 */
import type { Kind, Request, RequestBody, Response, ResponseOf } from './protocol';

export interface WorkerLike {
  postMessage(message: Request): void;
  terminate(): void;
  onmessage: ((e: { data: Response }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export type Outcome<K extends Kind> = { type: 'ok'; response: ResponseOf<K> } | { type: 'stale' } | { type: 'timeout' } | { type: 'crashed'; message: string };

type Settle = (o: Outcome<Kind>) => void;
interface Pending {
  kind: Kind;
  settle: Settle;
  timer: ReturnType<typeof setTimeout>;
}

export const WATCHDOG_MS = 5000;

export class CompilerClient {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly timeoutMs = WATCHDOG_MS,
  ) {}

  request<K extends Kind>(body: RequestBody<K>): Promise<Outcome<K>> {
    for (const [id, p] of this.pending) {
      if (p.kind !== body.kind) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.settle({ type: 'stale' });
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.restart({ type: 'timeout' }), this.timeoutMs);
      this.pending.set(id, { kind: body.kind, settle: resolve as Settle, timer });
      try {
        this.ensure().postMessage({ ...body, id } as Request);
      } catch (e) {
        this.restart({ type: 'crashed', message: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  dispose() {
    this.restart({ type: 'stale' });
    this.worker = null;
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.onmessage = (e) => {
      if (this.worker !== w) return;
      const p = this.pending.get(e.data.id);
      // Not pending: it was replaced by a newer request, or the worker was restarted since.
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(e.data.id);
      p.settle({ type: 'ok', response: e.data });
    };
    w.onerror = (e) => {
      if (this.worker === w) this.restart({ type: 'crashed', message: e.message ?? 'The worker stopped.' });
    };
    this.worker = w;
    return w;
  }

  /** Throw the worker away, end everything waiting on it with `why`, and let the next request start a fresh one. */
  private restart(why: Outcome<Kind>) {
    const old = this.worker;
    this.worker = null;
    old?.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.settle(why);
    }
  }
}
