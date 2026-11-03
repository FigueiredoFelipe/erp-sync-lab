// Seeded PRNG (mulberry32): same seed, same sequence, so seed data is reproducible.

export type Rng = {
  next(): number;
  int(min: number, max: number): number;
  between(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  sample<T>(items: readonly T[], count: number): T[];
};

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const sample = <T>(items: readonly T[], count: number): T[] => {
    const pool = [...items];
    const result: T[] = [];
    while (result.length < count && pool.length > 0) {
      result.push(pool.splice(int(0, pool.length - 1), 1)[0] as T);
    }
    return result;
  };

  return {
    next,
    int,
    between: (min, max) => min + next() * (max - min),
    pick: (items) => items[int(0, items.length - 1)] as (typeof items)[number],
    sample,
  };
}
