export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
  bool(p?: number): boolean;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: readonly T[]): T[];
}

/** mulberry32 over a scrambled seed, so consecutive seeds give unrelated streams. */
export function createRng(seed: number): Rng {
  let s = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 4; i++) next();
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: (xs) => xs[int(0, xs.length - 1)]!,
    shuffle: (xs) => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = int(0, i);
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    },
  };
}
